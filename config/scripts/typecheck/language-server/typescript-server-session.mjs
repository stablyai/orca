// Runs the TypeScript server behind a stable client connection: it stops after an idle period, freeing its memory and
// file watches, and starts again on the next request.
import { applyContentChanges } from './lsp-document-text.mjs'

const SESSION_ID_PREFIX = 'orca-session-'
const WATCHED_FILES = 'workspace/didChangeWatchedFiles'
const SHUTDOWN_GRACE_MS = 5000
// Matches the plugin's startupTimeout: a restart that hasn't initialized by then is abandoned.
const RESTART_TIMEOUT_MS = 60_000
const REQUEST_CANCELLED = -32800
const CONTENT_MODIFIED = -32801
const SERVER_CANCELLED = -32802
const REQUEST_FAILED = -32803
// Requests held while a server starts or stops; past this the agent is told to retry.
const MAX_QUEUED_REQUESTS = 64
// A server this far behind on answers is treated as stuck, and an agent this far behind gets no more server requests.
const MAX_OPEN_REQUESTS = 4096
// Servers given up on but not yet exited; past this, a restart fails until one exits.
const MAX_RETIRED = 2
// Configuration registrations hold nothing on the client, so a restarted server's repeat of one is answered here.
const CONFIGURATION = 'workspace/didChangeConfiguration'
const MAX_HELD_CONFIGURATIONS = 64
// Without a running server these only update what the next one is given at start.
const SESSION_STATE = new Set([
  'textDocument/didOpen',
  'textDocument/didChange',
  'textDocument/didClose',
  'workspace/didChangeConfiguration',
  'workspace/didChangeWorkspaceFolders'
])
const WAKING_STATE = new Set(['textDocument/didOpen', 'textDocument/didChange'])
const QUEUED_EXIT = Symbol('exit')
// Not agent activity: cancellations, and file events from a client that watches for itself.
const NOT_ACTIVITY = new Set(['$/cancelRequest', WATCHED_FILES])

export function createServerSession({
  idleMs,
  startServer,
  toClient,
  onEnd,
  // Requests the wrapper makes on its own (diagnostic pulls after a refresh) are not agent activity.
  isBackgroundRequest = () => false,
  // Files may have changed while no server was watching; the caller re-pulls diagnostics for open documents.
  onRestarted = () => {},
  setTimer = setTimeout,
  clearTimer = clearTimeout
}) {
  let server = null
  let state = 'stopped'
  let initialize = null
  let configuration = null
  let closed = false
  let nextId = 0
  let replayId = null
  let shutdownId = null
  // A server that registered other capabilities with the client keeps them for the session, so it is never restarted.
  let registered = false
  // Configuration registrations the client accepted, by id, and the ones it is still answering, by relayed id.
  const heldConfigurations = new Map()
  const offeredConfigurations = new Map()
  let idleTimer
  let killTimer
  let idleExpired = false
  let generation = 0
  // Retired server -> its SIGKILL timer; only its exit frees the slot.
  const retired = new Map()
  // Requests by id (in arrival order) plus a queued exit; notifications never wait here.
  const queue = new Map()
  let wakeWanted = false
  const pending = new Set()
  // The current server's requests to the client, under wrapper ids so a late answer can't reach a newer server.
  const relayed = new Map()
  const relayedByServerId = new Map()
  // What the running (or last) server has seen, so a new one can be brought to the same state.
  const documents = new Map()
  // Current workspace folders by uri; a restart sends one change from the initialize set to this.
  let folders = null

  const track = (message) => {
    const { method, params } = message
    const uri = params?.textDocument?.uri
    if (method === 'textDocument/didOpen') {
      const { languageId, version, text } = params.textDocument
      documents.set(uri, { languageId, version, text })
    } else if (method === 'textDocument/didChange' && documents.has(uri)) {
      const document = documents.get(uri)
      document.version = params.textDocument.version
      document.text = applyContentChanges(document.text, params.contentChanges)
    } else if (method === 'textDocument/didClose') {
      documents.delete(uri)
    } else if (method === 'workspace/didChangeConfiguration') {
      configuration = message
    } else if (method === 'workspace/didChangeWorkspaceFolders') {
      folders ??= new Map(
        (initialize?.params?.workspaceFolders ?? []).map((folder) => [folder.uri, folder])
      )
      for (const { uri } of params?.event?.removed ?? []) {
        folders.delete(uri)
      }
      for (const folder of params?.event?.added ?? []) {
        folders.set(folder.uri, folder)
      }
    }
  }

  const write = (message) => {
    if (message.id !== undefined && message.method) {
      pending.add(message.id)
    }
    track(message)
    server.write(message)
  }

  const armIdle = () => {
    idleExpired = false
    clearTimer(idleTimer)
    if (Number.isFinite(idleMs)) {
      idleTimer = setTimer(onIdle, idleMs)
    }
  }

  // Messages and exits from a server the session already gave up on are ignored.
  const launch = () => {
    state = 'starting'
    const own = ++generation
    const handle = startServer({
      onMessage: (message) => own === generation && fromServer(message),
      onExit: (code, signal) => {
        if (own === generation) {
          onExit(code, signal)
        } else {
          clearTimer(retired.get(handle))
          retired.delete(handle)
        }
      }
    })
    server = handle
  }

  // A server that misses a deadline is treated as gone now, then killed for good if it lingers.
  const retire = () => {
    if (state === 'ready') {
      state = 'stopping'
    }
    const stuck = server
    stuck.kill()
    retired.set(
      stuck,
      setTimer(() => stuck.kill('SIGKILL'), SHUTDOWN_GRACE_MS)
    )
    onExit(null, 'SIGTERM')
  }

  // The wrapper never exits while a server it gave up on may still be running.
  const end = (code) => {
    for (const [stuck, timer] of retired) {
      clearTimer(timer)
      stuck.kill('SIGKILL')
    }
    retired.clear()
    onEnd(code)
  }

  const stop = () => {
    clearTimer(idleTimer)
    state = 'stopping'
    shutdownId = `${SESSION_ID_PREFIX}${++nextId}`
    server.write({ jsonrpc: '2.0', id: shutdownId, method: 'shutdown' })
    killTimer = setTimer(retire, SHUTDOWN_GRACE_MS)
  }

  // Requests either way (the agent's to the server, the server's to the agent) count as unanswered.
  const drained = () => pending.size === 0 && relayed.size === 0

  const stopIfIdle = () => {
    if (idleExpired && drained() && state === 'ready') {
      stop()
    }
  }

  // With requests still out, the stop waits for the last answer, or one more idle period at most.
  function onIdle() {
    if (state !== 'ready' || registered) {
      return
    }
    if (drained() || idleExpired) {
      stop()
    } else {
      idleExpired = true
      idleTimer = setTimer(onIdle, idleMs)
    }
  }

  // A restart that fails (mid-install the package can be missing) fails the waiting work; the next request retries.
  const failWake = (reason) => {
    console.error(`agent-typescript-lsp: cannot start server: ${reason}`)
    state = 'stopped'
    server = null
    replayId = null
    wakeWanted = false
    let exit = false
    const queued = [...queue.values()]
    queue.clear()
    for (const message of queued) {
      if (message.method === 'exit') {
        exit = true
      } else if (message.method === 'shutdown') {
        toClient({ jsonrpc: '2.0', id: message.id, result: null })
      } else {
        toClient({
          jsonrpc: '2.0',
          id: message.id,
          error: { code: REQUEST_FAILED, message: reason }
        })
      }
    }
    if (exit) {
      end(0)
    }
  }

  // Same initialize the client sent, then its open documents, so the new server sees what the old one saw.
  const wake = () => {
    if (retired.size >= MAX_RETIRED) {
      failWake('previous servers have not exited yet')
      return
    }
    try {
      launch()
    } catch (error) {
      failWake(error.message)
      return
    }
    replayId = `${SESSION_ID_PREFIX}${++nextId}`
    server.write({ ...initialize, id: replayId })
    killTimer = setTimer(retire, RESTART_TIMEOUT_MS)
  }

  const finishReplay = () => {
    clearTimer(killTimer)
    replayId = null
    server.write({ jsonrpc: '2.0', method: 'initialized', params: {} })
    if (configuration) {
      server.write(configuration)
    }
    const initialFolders = initialize.params?.workspaceFolders ?? []
    if (folders) {
      const initialUris = new Set(initialFolders.map(({ uri }) => uri))
      const added = [...folders.values()].filter(({ uri }) => !initialUris.has(uri))
      const removed = initialFolders.filter(({ uri }) => !folders.has(uri))
      if (added.length > 0 || removed.length > 0) {
        server.write({
          jsonrpc: '2.0',
          method: 'workspace/didChangeWorkspaceFolders',
          params: { event: { added, removed } }
        })
      }
    }
    for (const [uri, { languageId, version, text }] of documents) {
      server.write({
        jsonrpc: '2.0',
        method: 'textDocument/didOpen',
        params: { textDocument: { uri, languageId, version, text } }
      })
    }
    state = 'ready'
    armIdle()
    drain()
    onRestarted()
  }

  const drain = () => {
    const queued = [...queue.values()]
    queue.clear()
    for (const message of queued) {
      dispatch(message)
    }
    if (wakeWanted && state === 'stopped') {
      wake()
    }
    if (state === 'ready') {
      wakeWanted = false
    }
  }

  const enqueue = (message) => {
    if (message.id === undefined) {
      queue.set(QUEUED_EXIT, message)
    } else if (queue.size < MAX_QUEUED_REQUESTS) {
      queue.set(message.id, message)
    } else {
      toClient({
        jsonrpc: '2.0',
        id: message.id,
        error: { code: SERVER_CANCELLED, message: 'server restarting' }
      })
    }
  }

  const dispatch = (message) => {
    const { method } = message
    if (!method) {
      // Answers go to the server that asked, even mid-start: it may wait on them before finishing initialize.
      if (server && relayed.has(message.id)) {
        const serverId = relayed.get(message.id)
        relayed.delete(message.id)
        relayedByServerId.delete(serverId)
        const offered = offeredConfigurations.get(message.id) ?? []
        offeredConfigurations.delete(message.id)
        if (!message.error && heldConfigurations.size + offered.length <= MAX_HELD_CONFIGURATIONS) {
          for (const registration of offered) {
            heldConfigurations.set(registration.id, JSON.stringify(registration))
          }
        }
        server.write({ ...message, id: serverId })
        stopIfIdle()
      }
      return
    }
    const background = isBackgroundRequest(message)
    // A pull while a server is stopping waits for the next one; with nothing to wake it, it is answered as cancelled.
    if (background && state === 'stopped') {
      toClient({
        jsonrpc: '2.0',
        id: message.id,
        error: { code: REQUEST_CANCELLED, message: 'server stopped' }
      })
      return
    }
    if (state !== 'ready') {
      if (SESSION_STATE.has(method)) {
        // The next server is given the current documents, settings and folders when it starts.
        track(message)
        // Held requests would run against text they never saw (positions can sit anywhere in params), so any edit
        // sends them back to be asked again.
        const edited = method === 'textDocument/didChange' || method === 'textDocument/didClose'
        for (const [id, queued] of queue) {
          if (edited && queued.method !== 'shutdown' && queued !== queue.get(QUEUED_EXIT)) {
            queue.delete(id)
            toClient({
              jsonrpc: '2.0',
              id,
              error: { code: CONTENT_MODIFIED, message: 'document changed' }
            })
          }
        }
        if (WAKING_STATE.has(method)) {
          wakeWanted = true
          if (state === 'stopped') {
            wake()
          }
        }
      } else if (state === 'stopped' && method === 'shutdown') {
        toClient({ jsonrpc: '2.0', id: message.id, result: null })
      } else if (state === 'stopped' && method === 'exit') {
        end(0)
      } else if (method === '$/cancelRequest') {
        const cancelled = queue.get(message.params?.id)
        if (cancelled) {
          queue.delete(cancelled.id)
          toClient({
            jsonrpc: '2.0',
            id: cancelled.id,
            error: { code: REQUEST_CANCELLED, message: 'cancelled' }
          })
        }
      } else if (message.id !== undefined || method === 'exit') {
        // Other notifications (file events, traces, saves) mean nothing to a server that rereads everything.
        enqueue(message)
        if (state === 'stopped') {
          wake()
        }
      }
      return
    }
    if (message.id !== undefined && pending.size >= MAX_OPEN_REQUESTS) {
      console.error('agent-typescript-lsp: server stopped answering; restarting it')
      retire()
      if (!registered) {
        dispatch(message)
      }
      return
    }
    if (!NOT_ACTIVITY.has(method) && !background) {
      armIdle()
    }
    write(message)
  }

  const relayToClient = (message) => {
    if (relayed.size >= MAX_OPEN_REQUESTS) {
      server.write({
        jsonrpc: '2.0',
        id: message.id,
        error: { code: REQUEST_FAILED, message: 'client not answering' }
      })
      return
    }
    const id = `${SESSION_ID_PREFIX}${++nextId}`
    relayed.set(id, message.id)
    relayedByServerId.set(message.id, id)
    toClient({ ...message, id })
    return id
  }

  const register = (message) => {
    const registrations = message.params?.registrations ?? []
    if (!registrations.every((registration) => registration.method === CONFIGURATION)) {
      registered = true
      idleExpired = false
      clearTimer(idleTimer)
      relayToClient(message)
    } else if (
      registrations.every(
        (registration) => heldConfigurations.get(registration.id) === JSON.stringify(registration)
      )
    ) {
      server.write({ jsonrpc: '2.0', id: message.id, result: null })
    } else {
      const id = relayToClient(message)
      if (id !== undefined) {
        offeredConfigurations.set(id, registrations)
      }
    }
  }

  function fromServer(message) {
    if (replayId !== null && message.id === replayId && !message.method) {
      if (message.error) {
        console.error(`agent-typescript-lsp: restart failed: ${message.error.message}`)
        retire()
      } else {
        finishReplay()
      }
    } else if (shutdownId !== null && message.id === shutdownId && !message.method) {
      shutdownId = null
      server.write({ jsonrpc: '2.0', method: 'exit' })
    } else if (!message.method && pending.delete(message.id)) {
      toClient(message)
      stopIfIdle()
    } else if (message.method === 'client/registerCapability' && message.id !== undefined) {
      register(message)
    } else if (message.method && message.id !== undefined) {
      if (message.method === 'client/unregisterCapability') {
        for (const { id } of message.params?.unregisterations ?? []) {
          heldConfigurations.delete(id)
        }
      }
      relayToClient(message)
    } else if (message.method === '$/cancelRequest') {
      const relayedId = relayedByServerId.get(message.params?.id)
      if (relayedId !== undefined) {
        toClient({ ...message, params: { ...message.params, id: relayedId } })
      }
    } else {
      toClient(message)
    }
  }

  function onExit(code, signal) {
    generation++
    clearTimer(killTimer)
    clearTimer(idleTimer)
    const expected = state === 'stopping'
    const waking = state === 'starting' && replayId !== null
    server = null
    state = 'stopped'
    // Requests the gone server never answered get an answer, so nothing waits on them.
    for (const id of pending) {
      toClient({ jsonrpc: '2.0', id, error: { code: REQUEST_FAILED, message: 'server stopped' } })
    }
    pending.clear()
    relayed.clear()
    relayedByServerId.clear()
    offeredConfigurations.clear()
    replayId = null
    shutdownId = null
    if (closed || !(expected || waking)) {
      end(code ?? (signal ? 1 : 0))
      return
    }
    // The client's registrations belong to this server, so with any it ends like a crash and the client restarts it.
    if (registered) {
      end(1)
      return
    }
    if (waking) {
      failWake(`server exited during restart (${code ?? signal})`)
      return
    }
    drain()
  }

  return {
    fromClient(message) {
      if (message.method === 'initialize' && !initialize) {
        // Replayed edits are applied in UTF-16 offsets, so offer no other encoding; the server reports its choice.
        const { positionEncodings: _offered, ...general } =
          message.params?.capabilities?.general ?? {}
        message = {
          ...message,
          params: { ...message.params, capabilities: { ...message.params?.capabilities, general } }
        }
        initialize = message
        launch()
        state = 'ready'
        armIdle()
        write(initialize)
        return
      }
      dispatch(message)
    },
    close() {
      closed = true
      if (server) {
        server.end()
      } else {
        end(0)
      }
    },
    kill(signal) {
      closed = true
      if (server) {
        server.kill(signal)
      } else {
        end(0)
      }
    }
  }
}
