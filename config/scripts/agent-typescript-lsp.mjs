// Adapt TypeScript 7 pull diagnostics for agent clients that only accept publishDiagnostics.
import { spawnProcess } from '@orca/process-host'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { resolveProjectCompilerInfo } from './run-typecheck-projects-in-parallel.mjs'
import { resolveTsrsLauncher, supportsTsrs } from './tsrs-typecheck-compiler.mjs'

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

// For push-only clients, pull diagnostics after open/change/save or server refresh, then publish them.
export function createDiagnosticsBridge({
  toClient,
  toServer,
  debounceMs = PULL_DEBOUNCE_MS,
  setTimer = setTimeout,
  clearTimer = clearTimeout
}) {
  let bridging = false
  let nextId = 0
  const versions = new Map()
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
      } else if (method === 'exit') {
        for (const timer of timers.values()) {
          clearTimer(timer)
        }
        timers.clear()
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

function runLanguageServer() {
  const root = process.env.CLAUDE_PROJECT_DIR || fileURLToPath(new URL('../..', import.meta.url))
  const command = resolveTypescriptLanguageServer({ root })
  const child = spawnProcess({ ...command, stdio: ['pipe', 'pipe', 'inherit'] })
  const bridge = createDiagnosticsBridge({
    toClient: (message) => process.stdout.write(encodeLspMessage(message)),
    toServer: (message) => child.stdin.write(encodeLspMessage(message))
  })
  process.stdin.on(
    'data',
    createLspMessageReader((message) => bridge.fromClient(message))
  )
  child.stdout.on(
    'data',
    createLspMessageReader((message) => bridge.fromServer(message))
  )
  // The client owns the session: when it goes away, so does the server.
  process.stdin.on('end', () => child.stdin.end())
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(signal, () => child.kill(signal))
  }
  child.on('error', (error) => {
    console.error(`agent-typescript-lsp: ${error.message}`)
    process.exit(1)
  })
  child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runLanguageServer()
}
