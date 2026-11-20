// Runs the TypeScript server behind a stable client connection: it stops after an idle period, starts again on the
// next request, and serves the server's file watches from one workspace watcher when the client can't watch.
import { readFileSync } from 'node:fs'
import { isAbsolute, posix, relative, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const SESSION_ID_PREFIX = 'orca-session-'
const WATCHED_FILES = 'workspace/didChangeWatchedFiles'
const SHUTDOWN_GRACE_MS = 5000
// These carry no work for the server, so they never wake a stopped one.
const NON_WAKING = new Set(['$/cancelRequest', '$/setTrace', 'textDocument/didClose', 'exit'])
const CHANGE_TYPE = { create: 1, update: 2, delete: 3 }
const WATCH_KIND_ALL = 7

function toPosix(path) {
  return sep === '/' ? path : path.split(sep).join('/')
}

function baseToPath(baseUri) {
  const uri = typeof baseUri === 'string' ? baseUri : baseUri?.uri
  try {
    return uri ? fileURLToPath(uri) : null
  } catch {
    return null
  }
}

// Watches outside the workspace (package stores, global caches) are accepted and never fire; installs restart the server.
function parseWatchers(root, watchers = []) {
  const parsed = []
  for (const { globPattern, kind = WATCH_KIND_ALL } of watchers) {
    if (typeof globPattern === 'string') {
      parsed.push({ base: null, pattern: globPattern, kind })
      continue
    }
    const base = baseToPath(globPattern?.baseUri)
    const fromRoot = base === null ? '..' : relative(root, base)
    if (!fromRoot.startsWith('..') && !isAbsolute(fromRoot)) {
      parsed.push({ base, pattern: globPattern.pattern, kind })
    }
  }
  return parsed
}

function watcherMatches({ base, pattern, kind }, path, type) {
  if ((kind & (type === 3 ? 4 : type)) === 0) {
    return false
  }
  if (base === null) {
    return posix.matchesGlob(toPosix(path), pattern)
  }
  const fromBase = relative(base, path)
  return (
    fromBase !== '' &&
    !fromBase.startsWith('..') &&
    !isAbsolute(fromBase) &&
    posix.matchesGlob(toPosix(fromBase), pattern)
  )
}

export function createServerSession({
  root,
  idleMs,
  startServer,
  toClient,
  onEnd,
  watchWorkspace,
  watchInstalls,
  readText = (uri) => readFileSync(fileURLToPath(uri), 'utf8'),
  setTimer = setTimeout,
  clearTimer = clearTimeout
}) {
  let server = null
  let state = 'stopped'
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
  const documents = new Map()
  const registrations = new Map()

  const write = (message) => {
    if (message.id !== undefined && message.method) {
      pending.add(message.id)
    }
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
    workspaceWatch = watchWorkspace(root, onWorkspaceEvents)
    stopInstallWatch = watchInstalls(root, () => {
      restartWhenIdle = true
      stopIfQuiet()
    })
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
    launch()
    replayId = `${SESSION_ID_PREFIX}${++nextId}`
    server.write({ ...initialize, id: replayId })
  }

  const finishReplay = () => {
    replayId = null
    server.write({ jsonrpc: '2.0', method: 'initialized', params: {} })
    if (configuration) {
      server.write(configuration)
    }
    for (const [uri, document] of documents) {
      let text = document.text
      if (text === null) {
        try {
          text = readText(uri)
        } catch {
          continue
        }
      }
      server.write({
        jsonrpc: '2.0',
        method: 'textDocument/didOpen',
        params: {
          textDocument: { uri, languageId: document.languageId, version: document.version, text }
        }
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

  const track = (message) => {
    const { method, params } = message
    const uri = params?.textDocument?.uri
    if (method === 'textDocument/didOpen') {
      const { languageId, version, text } = params.textDocument
      documents.set(uri, { languageId, version, text })
    } else if (method === 'textDocument/didChange' && documents.has(uri)) {
      const changes = params.contentChanges ?? []
      const whole = changes.length > 0 && changes.every((change) => !change.range)
      documents.set(uri, {
        ...documents.get(uri),
        version: params.textDocument.version,
        text: whole ? changes.at(-1).text : null
      })
    } else if (method === 'textDocument/didClose') {
      documents.delete(uri)
    } else if (method === 'workspace/didChangeConfiguration') {
      configuration = message
    }
  }

  const dispatch = (message) => {
    const { method } = message
    if (state === 'stopped') {
      if (method === 'shutdown') {
        toClient({ jsonrpc: '2.0', id: message.id, result: null })
      } else if (method === 'exit') {
        onEnd(0)
      } else if (method && !NON_WAKING.has(method)) {
        queue.push(message)
        wake()
      }
      return
    }
    if (state !== 'ready') {
      queue.push(message)
      return
    }
    if (method && method !== '$/cancelRequest') {
      armIdle()
    }
    write(message)
  }

  function fromServer(message) {
    if (message.id === replayId && !message.method) {
      finishReplay()
      return
    }
    if (message.id === shutdownId && !message.method) {
      server.write({ jsonrpc: '2.0', method: 'exit' })
      return
    }
    if (!message.method && pending.delete(message.id)) {
      toClient(message)
      if (restartWhenIdle) {
        stopIfQuiet()
      }
      return
    }
    if (bridgingWatches && message.method === 'client/registerCapability') {
      const forwarded = []
      for (const registration of message.params?.registrations ?? []) {
        if (registration.method === WATCHED_FILES) {
          registrations.set(
            registration.id,
            parseWatchers(root, registration.registerOptions?.watchers)
          )
        } else {
          forwarded.push(registration)
        }
      }
      startWatching()
      if (forwarded.length > 0) {
        toClient({ ...message, params: { ...message.params, registrations: forwarded } })
      } else {
        server.write({ jsonrpc: '2.0', id: message.id, result: null })
      }
      return
    }
    if (bridgingWatches && message.method === 'client/unregisterCapability') {
      // The protocol spells this field "unregisterations".
      const forwarded = []
      for (const unregistration of message.params?.unregisterations ?? []) {
        if (!registrations.delete(unregistration.id)) {
          forwarded.push(unregistration)
        }
      }
      if (forwarded.length > 0) {
        toClient({ ...message, params: { unregisterations: forwarded } })
      } else {
        server.write({ jsonrpc: '2.0', id: message.id, result: null })
      }
      return
    }
    toClient(message)
  }

  function onExit(code, signal) {
    clearTimer(killTimer)
    clearTimer(idleTimer)
    stopWatching()
    const expected = state === 'stopping'
    server = null
    state = 'stopped'
    pending.clear()
    registrations.clear()
    if (closed || !expected) {
      onEnd(code ?? (signal ? 1 : 0))
      return
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
      track(message)
      if (message.method === 'initialize' && !initialize) {
        const capabilities = message.params?.capabilities ?? {}
        bridgingWatches = !capabilities.workspace?.didChangeWatchedFiles?.dynamicRegistration
        initialize = bridgingWatches
          ? {
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
          : message
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
