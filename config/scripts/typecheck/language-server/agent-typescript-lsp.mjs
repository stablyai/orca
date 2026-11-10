// Adapt TypeScript 7 pull diagnostics for agent clients that only accept publishDiagnostics.
import { spawnProcess } from '@orca/process-host'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { resolveProjectCompilerInfo } from '../project-execution/run-typecheck-projects-in-parallel.mjs'
import { resolveTsrsLauncher, supportsTsrs } from '../project-execution/tsrs-typecheck-compiler.mjs'

const PULL_DEBOUNCE_MS = 100
const BRIDGE_ID_PREFIX = 'orca-diagnostics-'

export function resolveTypescriptLanguageServer({
  root,
  env = process.env,
  platform = process.platform,
  arch = process.arch
}) {
  const requested = env.ORCA_TYPESCRIPT_LSP ?? 'auto'
  if (!['auto', 'tsrs', 'tsc'].includes(requested)) {
    throw new Error('ORCA_TYPESCRIPT_LSP must be auto, tsrs, or tsc')
  }
  // tsrs answers first diagnostics in about a third of the time and memory on supported hosts.
  const server = requested === 'auto' ? (supportsTsrs(platform, arch) ? 'tsrs' : 'tsc') : requested
  const launcher =
    server === 'tsrs'
      ? resolveTsrsLauncher(root).launcher
      : resolveProjectCompilerInfo('tsconfig.json', root).program
  return { server, program: process.execPath, args: [launcher, '--lsp', '--stdio'], cwd: root }
}

export function createLspMessageReader(onMessage) {
  let pending = Buffer.alloc(0)
  return (chunk) => {
    pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk])
    for (;;) {
      const headerEnd = pending.indexOf('\r\n\r\n')
      if (headerEnd === -1) {
        return
      }
      const length = /content-length:\s*(\d+)/i.exec(pending.subarray(0, headerEnd).toString())
      if (!length) {
        throw new Error('LSP message is missing Content-Length')
      }
      const bodyStart = headerEnd + 4
      const bodyEnd = bodyStart + Number(length[1])
      if (pending.length < bodyEnd) {
        return
      }
      const body = pending.subarray(bodyStart, bodyEnd).toString('utf8')
      pending = pending.subarray(bodyEnd)
      onMessage(JSON.parse(body))
    }
  }
}

export function encodeLspMessage(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8')
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body])
}

/** End the session's server: close its input, then stop it; already-exited children tolerate both. */
export function terminateLanguageServerChild(child) {
  try {
    child.stdin.end()
  } catch {
    // A child that already exited has nothing to close.
  }
  try {
    child.kill()
  } catch {
    // Already gone.
  }
}

// For push-only clients, pull diagnostics after open/change/save or server refresh, then publish them.
export function createDiagnosticsBridge({
  toClient,
  toServer,
  onExit,
  debounceMs = PULL_DEBOUNCE_MS,
  setTimer = setTimeout,
  clearTimer = clearTimeout
}) {
  let bridging = false
  let nextId = 0
  const versions = new Map()
  // Every open document, bridging or not: the idle reaper must not retire a server a session can still use.
  const openDocuments = new Set()
  const timers = new Map()
  const inFlight = new Map()

  const pull = (uri) => {
    timers.delete(uri)
    if (!versions.has(uri)) {
      return
    }
    const id = `${BRIDGE_ID_PREFIX}${++nextId}`
    inFlight.set(id, { uri, version: versions.get(uri) })
    toServer({
      jsonrpc: '2.0',
      id,
      method: 'textDocument/diagnostic',
      params: { textDocument: { uri } }
    })
  }
  const schedule = (uri) => {
    clearTimer(timers.get(uri))
    timers.set(
      uri,
      setTimer(() => pull(uri), debounceMs)
    )
  }

  return {
    /** Documents the client has open; an idle session with none can give its server back. */
    openDocumentCount: () => openDocuments.size,
    fromClient(message) {
      const { method, params } = message
      if (method === 'initialize') {
        const capabilities = params?.capabilities ?? {}
        bridging = !capabilities.textDocument?.diagnostic
        if (bridging) {
          message = {
            ...message,
            params: {
              ...params,
              capabilities: {
                ...capabilities,
                textDocument: {
                  ...capabilities.textDocument,
                  diagnostic: { dynamicRegistration: false, relatedDocumentSupport: false }
                },
                workspace: { ...capabilities.workspace, diagnostics: { refreshSupport: true } }
              }
            }
          }
        }
      }
      toServer(message)
      const openedUri = params?.textDocument?.uri
      if (method === 'textDocument/didOpen' && typeof openedUri === 'string') {
        openDocuments.add(openedUri)
      } else if (method === 'textDocument/didClose' && typeof openedUri === 'string') {
        openDocuments.delete(openedUri)
      }
      // exit ends the session whatever the client's capabilities are.
      if (method === 'exit') {
        for (const timer of timers.values()) {
          clearTimer(timer)
        }
        timers.clear()
        // LSP exit is the client ending the session; the child must not linger after it.
        onExit?.()
        return
      }
      if (!bridging) {
        return
      }
      const uri = params?.textDocument?.uri
      if (method === 'textDocument/didOpen' || method === 'textDocument/didChange') {
        versions.set(uri, params.textDocument.version ?? null)
        schedule(uri)
      } else if (method === 'textDocument/didSave') {
        schedule(uri)
      } else if (method === 'textDocument/didClose') {
        versions.delete(uri)
        clearTimer(timers.get(uri))
        timers.delete(uri)
        toClient({
          jsonrpc: '2.0',
          method: 'textDocument/publishDiagnostics',
          params: { uri, diagnostics: [] }
        })
      }
    },
    fromServer(message) {
      if (typeof message.id === 'string' && inFlight.has(message.id)) {
        const { uri, version } = inFlight.get(message.id)
        inFlight.delete(message.id)
        // A newer edit already scheduled its own pull; publishing this one would flash stale errors.
        if (message.result?.kind === 'full' && versions.get(uri) === version) {
          toClient({
            jsonrpc: '2.0',
            method: 'textDocument/publishDiagnostics',
            params: {
              uri,
              ...(typeof version === 'number' ? { version } : {}),
              diagnostics: message.result.items
            }
          })
        }
        return
      }
      if (bridging && message.method === 'workspace/diagnostic/refresh') {
        toServer({ jsonrpc: '2.0', id: message.id, result: null })
        for (const uri of versions.keys()) {
          schedule(uri)
        }
        return
      }
      toClient(message)
    }
  }
}

const DEFAULT_IDLE_MS = 60 * 60 * 1000
// Node clamps longer timers to 1 ms and warns; re-arming with the remainder would then spin.
const MAX_TIMER_MS = 2_147_483_647

/** `ORCA_TS_LSP_IDLE_MS`: positive ms to reap after, 0 to disable, absent or invalid for the default. */
export function resolveIdleMs(value = process.env.ORCA_TS_LSP_IDLE_MS) {
  if (value === undefined || value === '') {
    return DEFAULT_IDLE_MS
  }
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : DEFAULT_IDLE_MS
}

/** Retires a server whose client stayed connected but stopped using it. Watchers sharing a repo
 *  with a working agent must keep their server, so an open document always defers the reap. */
export function createIdleWatchdog({
  idleMs,
  hasOpenDocuments,
  onIdle,
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout
}) {
  if (!(idleMs > 0)) {
    return { start() {}, touch() {}, stop() {} }
  }
  let lastActivity = now()
  let timer = null
  const arm = (delayMs) => {
    timer = setTimer(check, Math.min(MAX_TIMER_MS, Math.max(0, delayMs)))
    // An idle watchdog must never keep the process alive by itself.
    if (timer && typeof timer.unref === 'function') {
      timer.unref()
    }
  }
  const check = () => {
    timer = null
    const idleFor = now() - lastActivity
    if (idleFor < idleMs) {
      arm(idleMs - idleFor)
      return
    }
    if (hasOpenDocuments()) {
      // Still in use: give it a full window and look again.
      lastActivity = now()
      arm(idleMs)
      return
    }
    onIdle()
  }
  return {
    start: () => arm(idleMs),
    touch: () => {
      lastActivity = now()
    },
    stop: () => {
      if (timer !== null) {
        clearTimer(timer)
      }
      timer = null
    }
  }
}

function runLanguageServer() {
  const root =
    process.env.CLAUDE_PROJECT_DIR || fileURLToPath(new URL('../../../..', import.meta.url))
  const command = resolveTypescriptLanguageServer({ root })
  const child = spawnProcess({ ...command, stdio: ['pipe', 'pipe', 'inherit'] })
  // A client-requested LSP exit is a deliberate stop, not a failure.
  let intentionalClientExit = false
  let stopForClientExit = () => {}
  const bridge = createDiagnosticsBridge({
    toClient: (message) => process.stdout.write(encodeLspMessage(message)),
    toServer: (message) => child.stdin.write(encodeLspMessage(message)),
    onExit: () => stopForClientExit()
  })
  // The idle reap is a deliberate stop, not a failure: report it as a clean exit.
  let intentionalIdleReap = false
  const watchdog = createIdleWatchdog({
    idleMs: resolveIdleMs(),
    hasOpenDocuments: () => bridge.openDocumentCount() > 0,
    onIdle: () => {
      // A client that stayed connected but stopped using the server must not pin its heap:
      // one server per agent session costs 5-6 GB on this monorepo (#38188).
      intentionalIdleReap = true
      child.stdin.end()
      child.kill()
      setTimeout(() => process.exit(0), 2_000).unref()
    }
  })
  watchdog.start()
  const reader = createLspMessageReader((message) => bridge.fromClient(message))
  const serverReader = createLspMessageReader((message) => bridge.fromServer(message))
  process.stdin.on('data', (chunk) => {
    watchdog.touch()
    reader(chunk)
  })
  child.stdout.on('data', (chunk) => {
    watchdog.touch()
    serverReader(chunk)
  })
  // The client owns the session: when it goes away, so does the server. `end` and
  // `close` can both fire for one departure, so close the child's input once.
  let clientInputClosed = false
  const closeChildInput = () => {
    if (clientInputClosed) {
      return
    }
    clientInputClosed = true
    watchdog.stop()
    try {
      child.stdin.end()
    } catch {
      // A child that already exited has nothing to close.
    }
  }
  process.stdin.on('end', closeChildInput)
  // A destroyed pipe emits `close` without `end`.
  process.stdin.on('close', closeChildInput)
  // LSP `exit` ends the session from the client's side: the server must not outlive it.
  stopForClientExit = () => {
    intentionalClientExit = true
    watchdog.stop()
    terminateLanguageServerChild(child)
  }
  process.on('exit', () => child.kill())
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
    process.on(signal, () => child.kill(signal))
  }
  child.on('error', (error) => {
    console.error(`agent-typescript-lsp: ${error.message}`)
    process.exit(1)
  })
  child.on('exit', (code, signal) =>
    process.exit(intentionalIdleReap || intentionalClientExit ? 0 : (code ?? (signal ? 1 : 0)))
  )
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runLanguageServer()
}
