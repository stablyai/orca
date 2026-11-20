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
  let withdrawId = null
  let idleTimer
  let killTimer
  let idleExpired = false
  let generation = 0
  // Requests by id (in arrival order) plus a queued exit; notifications never wait here.
  const queue = new Map()
  let wakeWanted = false
  const pending = new Set()
  // The current server's requests to the client, under wrapper ids so a late answer can't reach a newer server.
  const relayed = new Map()
  const relayedByServerId = new Map()
  // What the running (or last) server has seen, so a new one can be brought to the same state.
  const documents = new Map()
  // Registrations the client holds for the current server, by id; withdrawn when that server stops.
  const clientRegistrations = new Map()
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
    server = startServer({
      onMessage: (message) => own === generation && fromServer(message),
      onExit: (code, signal) => own === generation && onExit(code, signal)
    })
  }

  // A server that misses a deadline is treated as gone now, then killed for good if it lingers.
  const retire = () => {
    if (state === 'ready') {
      state = 'stopping'
    }
    const stuck = server
    stuck.kill()
    setTimer(() => stuck.kill('SIGKILL'), SHUTDOWN_GRACE_MS)
    onExit(null, 'SIGTERM')
  }

  const stop = () => {
    clearTimer(idleTimer)
    state = 'stopping'
    shutdownId = `${SESSION_ID_PREFIX}${++nextId}`
    server.write({ jsonrpc: '2.0', id: shutdownId, method: 'shutdown' })
    killTimer = setTimer(retire, SHUTDOWN_GRACE_MS)
  }

  // With requests still out, the stop waits for the last answer, or one more idle period at most.
  function onIdle() {
    if (state !== 'ready') {
      return
    }
    if (pending.size === 0 || idleExpired) {
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
      onEnd(0)
    }
  }

  // Same initialize the client sent, then its open documents, so the new server sees what the old one saw.
  const wake = () => {
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
      if (withdrawId !== null && message.id === withdrawId) {
        finishWithdraw()
      } else if (server && relayed.has(message.id)) {
        const { serverId, onAnswer } = relayed.get(message.id)
        relayed.delete(message.id)
        relayedByServerId.delete(serverId)
        onAnswer?.()
        server.write({ ...message, id: serverId })
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
        // A held request about a document edited since would run against text it never saw.
        const uri = message.params?.textDocument?.uri
        for (const [id, queued] of queue) {
          if (uri !== undefined && queued.params?.textDocument?.uri === uri) {
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
        onEnd(0)
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
      dispatch(message)
      return
    }
    if (!NOT_ACTIVITY.has(method) && !background) {
      armIdle()
    }
    write(message)
  }

  const answerServer = (id) => server.write({ jsonrpc: '2.0', id, result: null })

  const relayToClient = (message, onAnswer) => {
    if (relayed.size >= MAX_OPEN_REQUESTS) {
      server.write({
        jsonrpc: '2.0',
        id: message.id,
        error: { code: REQUEST_FAILED, message: 'client not answering' }
      })
      return
    }
    const id = `${SESSION_ID_PREFIX}${++nextId}`
    relayed.set(id, { serverId: message.id, onAnswer })
    relayedByServerId.set(message.id, id)
    toClient({ ...message, id })
  }

  const onRegister = (message) => {
    for (const registration of message.params?.registrations ?? []) {
      clientRegistrations.set(registration.id, { method: registration.method })
    }
    relayToClient(message)
  }

  const onUnregister = (message) => {
    // The protocol spells this field "unregisterations".
    const forwarded = []
    const withdrawn = []
    for (const unregistration of message.params?.unregisterations ?? []) {
      if (clientRegistrations.has(unregistration.id)) {
        forwarded.push(unregistration)
        withdrawn.push([unregistration.id, clientRegistrations.get(unregistration.id)])
      }
    }
    if (forwarded.length > 0) {
      // Still the client's until it answers, so a stop in between withdraws them too.
      relayToClient({ ...message, params: { unregisterations: forwarded } }, () => {
        // A registration re-added under the same id since then is a new entry and stays.
        for (const [id, entry] of withdrawn) {
          if (clientRegistrations.get(id) === entry) {
            clientRegistrations.delete(id)
          }
        }
      })
    } else {
      answerServer(message.id)
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
      if (idleExpired && pending.size === 0 && state === 'ready') {
        stop()
      }
    } else if (message.method === 'client/registerCapability') {
      onRegister(message)
    } else if (message.method === 'client/unregisterCapability') {
      onUnregister(message)
    } else if (message.method && message.id !== undefined) {
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

  // The next server registers again, so the client must have dropped the old registrations first.
  function finishWithdraw() {
    clearTimer(killTimer)
    withdrawId = null
    state = 'stopped'
    drain()
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
    replayId = null
    shutdownId = null
    if (closed || !(expected || waking)) {
      onEnd(code ?? (signal ? 1 : 0))
      return
    }
    if (waking) {
      failWake(`server exited during restart (${code ?? signal})`)
      return
    }
    if (clientRegistrations.size === 0) {
      drain()
      return
    }
    state = 'withdrawing'
    withdrawId = `${SESSION_ID_PREFIX}${++nextId}`
    toClient({
      jsonrpc: '2.0',
      id: withdrawId,
      method: 'client/unregisterCapability',
      params: {
        unregisterations: [...clientRegistrations].map(([id, { method }]) => ({ id, method }))
      }
    })
    clientRegistrations.clear()
    killTimer = setTimer(finishWithdraw, SHUTDOWN_GRACE_MS)
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
        onEnd(0)
      }
    },
    kill(signal) {
      closed = true
      if (server) {
        server.kill(signal)
      } else {
        onEnd(0)
      }
    }
  }
}
