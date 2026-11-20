// Runs the TypeScript server behind a stable client connection: it stops after an idle period, starts again on the
// next request, and serves the server's file watches from one workspace watcher when the client can't watch.
import { pathToFileURL } from 'node:url'
import { applyContentChanges } from './lsp-document-text.mjs'
import { parseWatchers, watcherMatches } from './lsp-watch-registrations.mjs'

const SESSION_ID_PREFIX = 'orca-session-'
const WATCHED_FILES = 'workspace/didChangeWatchedFiles'
const SHUTDOWN_GRACE_MS = 5000
const REQUEST_CANCELLED = -32800
const REQUEST_FAILED = -32803
// These carry no work for a stopped server; a new one rereads the disk anyway.
const NON_WAKING = new Set(['$/cancelRequest', '$/setTrace', 'textDocument/didClose', 'exit', WATCHED_FILES])
const CHANGE_TYPE = { create: 1, update: 2, delete: 3 }

export function createServerSession({
  root,
  idleMs,
  startServer,
  toClient,
  onEnd,
  watchWorkspace,
  watchInstalls,
  // Requests the wrapper makes on its own (diagnostic pulls after a refresh) are not agent activity.
  isBackgroundRequest = () => false,
  setTimer = setTimeout,
  clearTimer = clearTimeout
}) {
  let server = null
  let state = 'stopped'
  let clientInitialize = null
  let initialize = null
  let configuration = null
  let bridgingWatches = false
  let restartWhenIdle = false
  let closed = false
  let nextId = 0
  let replayId = null
  let shutdownId = null
  let idleTimer
  let killTimer
  let workspaceWatch = null
  let stopInstallWatch = null
  const queue = []
  const pending = new Set()
  // Requests the current server sent the client; an answer to an earlier server's request is dropped.
  const serverRequests = new Set()
  // What the running (or last) server has seen, so a new one can be brought to the same state.
  const documents = new Map()
  const registrations = new Map()
  // Registrations the client holds for the current server, by id; withdrawn when that server stops.
  const clientRegistrations = new Map()
  const folderChanges = []

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
      folderChanges.push(message)
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
    clearTimer(idleTimer)
    idleTimer = setTimer(onIdle, idleMs)
  }

  const stopWatching = () => {
    workspaceWatch?.stop()
    workspaceWatch = null
    stopInstallWatch?.()
    stopInstallWatch = null
  }

  const startWatching = () => {
    if (!bridgingWatches || state !== 'ready' || workspaceWatch || registrations.size === 0) {
      return
    }
    workspaceWatch = watchWorkspace(root, onWorkspaceEvents, onWatchFailed)
    stopInstallWatch = watchInstalls(root, () => {
      restartWhenIdle = true
      stopIfQuiet()
    })
  }

  // Without a working watcher, hand watching back to the server rather than serve stale files.
  const onWatchFailed = () => {
    if (!bridgingWatches) {
      return
    }
    bridgingWatches = false
    initialize = clientInitialize
    restartWhenIdle = true
    stopIfQuiet()
  }

  const withWatchCapability = (message) => {
    const capabilities = message.params?.capabilities ?? {}
    return {
      ...message,
      params: {
        ...message.params,
        capabilities: {
          ...capabilities,
          workspace: {
            ...capabilities.workspace,
            didChangeWatchedFiles: { dynamicRegistration: true, relativePatternSupport: true }
          }
        }
      }
    }
  }

  const onWorkspaceEvents = (events) => {
    if (state !== 'ready') {
      return
    }
    const watchers = [...registrations.values()].flat()
    const changes = []
    for (const { type, path } of events) {
      const changeType = CHANGE_TYPE[type]
      if (changeType && watchers.some((watcher) => watcherMatches(watcher, path, changeType))) {
        changes.push({ uri: pathToFileURL(path).href, type: changeType })
      }
    }
    if (changes.length > 0) {
      server.write({ jsonrpc: '2.0', method: WATCHED_FILES, params: { changes } })
    }
  }

  const launch = () => {
    state = 'starting'
    server = startServer({ onMessage: fromServer, onExit })
  }

  const stop = () => {
    clearTimer(idleTimer)
    stopWatching()
    state = 'stopping'
    shutdownId = `${SESSION_ID_PREFIX}${++nextId}`
    server.write({ jsonrpc: '2.0', id: shutdownId, method: 'shutdown' })
    killTimer = setTimer(() => server?.kill(), SHUTDOWN_GRACE_MS)
  }

  const stopIfQuiet = () => {
    if (state === 'ready' && pending.size === 0) {
      stop()
    }
  }

  function onIdle() {
    if (state === 'ready') {
      if (pending.size > 0) {
        armIdle()
      } else {
        stop()
      }
    }
  }

  // Same initialize the client sent, then its open documents, so the new server sees what the old one saw.
  const wake = () => {
    try {
      launch()
    } catch (error) {
      // Mid-install the server package can be missing; fail this work and try again on the next request.
      console.error(`agent-typescript-lsp: cannot start server: ${error.message}`)
      state = 'stopped'
      server = null
      for (const message of queue.splice(0)) {
        if (message.id !== undefined) {
          toClient({ jsonrpc: '2.0', id: message.id, error: { code: REQUEST_FAILED, message: error.message } })
        } else {
          track(message)
        }
      }
      return
    }
    replayId = `${SESSION_ID_PREFIX}${++nextId}`
    server.write({ ...initialize, id: replayId })
  }

  const finishReplay = () => {
    replayId = null
    server.write({ jsonrpc: '2.0', method: 'initialized', params: {} })
    if (configuration) {
      server.write(configuration)
    }
    for (const change of folderChanges) {
      server.write(change)
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
  }

  const drain = () => {
    for (const message of queue.splice(0)) {
      dispatch(message)
    }
  }

  const dispatch = (message) => {
    const { method } = message
    if (!method) {
      // Answers go to the server that asked, even mid-start: it may wait on them before finishing initialize.
      if (server && serverRequests.delete(message.id)) {
        server.write(message)
      }
      return
    }
    const background = isBackgroundRequest(message)
    if (background && state !== 'ready' && state !== 'starting') {
      toClient({ jsonrpc: '2.0', id: message.id, error: { code: REQUEST_CANCELLED, message: 'server stopped' } })
      return
    }
    if (state === 'stopped') {
      if (method === 'shutdown') {
        toClient({ jsonrpc: '2.0', id: message.id, result: null })
      } else if (method === 'exit') {
        onEnd(0)
      } else if (method === 'textDocument/didClose') {
        documents.delete(message.params?.textDocument?.uri)
      } else if (!NON_WAKING.has(method)) {
        queue.push(message)
        wake()
      }
      return
    }
    if (state !== 'ready') {
      queue.push(message)
      return
    }
    if (method !== '$/cancelRequest' && !background) {
      armIdle()
    }
    write(message)
  }

  const answerServer = (id) => server.write({ jsonrpc: '2.0', id, result: null })

  const onRegister = (message) => {
    const forwarded = []
    for (const registration of message.params?.registrations ?? []) {
      if (bridgingWatches && registration.method === WATCHED_FILES) {
        registrations.set(registration.id, parseWatchers(root, registration.registerOptions?.watchers))
      } else {
        clientRegistrations.set(registration.id, registration.method)
        forwarded.push(registration)
      }
    }
    startWatching()
    if (forwarded.length > 0) {
      serverRequests.add(message.id)
      toClient({ ...message, params: { ...message.params, registrations: forwarded } })
    } else {
      answerServer(message.id)
    }
  }

  const onUnregister = (message) => {
    // The protocol spells this field "unregisterations".
    const forwarded = []
    for (const unregistration of message.params?.unregisterations ?? []) {
      if (!registrations.delete(unregistration.id) && clientRegistrations.delete(unregistration.id)) {
        forwarded.push(unregistration)
      }
    }
    if (forwarded.length > 0) {
      serverRequests.add(message.id)
      toClient({ ...message, params: { unregisterations: forwarded } })
    } else {
      answerServer(message.id)
    }
  }

  function fromServer(message) {
    if (message.id === replayId && !message.method) {
      if (message.error) {
        console.error(`agent-typescript-lsp: restart failed: ${message.error.message}`)
        server.kill()
      } else {
        finishReplay()
      }
    } else if (message.id === shutdownId && !message.method) {
      shutdownId = null
      server.write({ jsonrpc: '2.0', method: 'exit' })
    } else if (!message.method && pending.delete(message.id)) {
      toClient(message)
      if (restartWhenIdle) {
        stopIfQuiet()
      }
    } else if (message.method === 'client/registerCapability') {
      onRegister(message)
    } else if (message.method === 'client/unregisterCapability') {
      onUnregister(message)
    } else {
      if (message.method && message.id !== undefined) {
        serverRequests.add(message.id)
      }
      toClient(message)
    }
  }

  function onExit(code, signal) {
    clearTimer(killTimer)
    clearTimer(idleTimer)
    stopWatching()
    const expected = state === 'stopping'
    server = null
    state = 'stopped'
    pending.clear()
    serverRequests.clear()
    registrations.clear()
    replayId = null
    shutdownId = null
    if (closed || !expected) {
      onEnd(code ?? (signal ? 1 : 0))
      return
    }
    if (clientRegistrations.size > 0) {
      toClient({
        jsonrpc: '2.0',
        id: `${SESSION_ID_PREFIX}${++nextId}`,
        method: 'client/unregisterCapability',
        params: {
          unregisterations: [...clientRegistrations].map(([id, method]) => ({ id, method }))
        }
      })
      clientRegistrations.clear()
    }
    if (restartWhenIdle) {
      restartWhenIdle = false
      wake()
    } else {
      drain()
    }
  }

  return {
    fromClient(message) {
      if (message.method === 'initialize' && !initialize) {
        clientInitialize = message
        bridgingWatches =
          !message.params?.capabilities?.workspace?.didChangeWatchedFiles?.dynamicRegistration
        initialize = bridgingWatches ? withWatchCapability(message) : message
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
