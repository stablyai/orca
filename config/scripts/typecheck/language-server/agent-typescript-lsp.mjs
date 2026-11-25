// Adapt TypeScript 7 pull diagnostics for agent clients that only accept publishDiagnostics.
import { spawnProcess } from '@orca/process-host'
import { signalProcessTree } from '@orca/process-host/process-tree-termination'
import { realpathSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { resolveProjectCompilerInfo } from '../project-execution/run-typecheck-projects-in-parallel.mjs'
import { resolveTsrsLauncher, supportsTsrs } from '../project-execution/tsrs-typecheck-compiler.mjs'
import { createServerSession } from './typescript-server-session.mjs'

const PULL_DEBOUNCE_MS = 100
const BRIDGE_ID_PREFIX = 'orca-diagnostics-'
// Agents sit idle for hours; a stopped server frees its memory and file watches and restarts on the next request.
const IDLE_MINUTES = 10
// setTimeout fires at once past 2^31-1 ms, so longer periods mean "never stop".
const MAX_IDLE_MS = 2 ** 31 - 1

export function resolveIdleMs(value = process.env.ORCA_TYPESCRIPT_LSP_IDLE_MINUTES) {
  const minutes = value === undefined ? IDLE_MINUTES : Number(value)
  const ms = minutes * 60_000
  return Number.isFinite(ms) && ms > 0 && ms <= MAX_IDLE_MS ? ms : Infinity
}

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
  const ownRequests = new WeakSet()

  const pull = (uri) => {
    timers.delete(uri)
    if (!versions.has(uri)) {
      return
    }
    const id = `${BRIDGE_ID_PREFIX}${++nextId}`
    inFlight.set(id, { uri, version: versions.get(uri) })
    const request = {
      jsonrpc: '2.0',
      id,
      method: 'textDocument/diagnostic',
      params: { textDocument: { uri } }
    }
    ownRequests.add(request)
    toServer(request)
  }
  const schedule = (uri) => {
    clearTimer(timers.get(uri))
    timers.set(
      uri,
      setTimer(() => pull(uri), debounceMs)
    )
  }

  const refreshAll = () => {
    if (bridging) {
      for (const uri of versions.keys()) {
        schedule(uri)
      }
    }
  }

  return {
    refreshAll,
    // Pulls the bridge makes itself, as opposed to requests it forwards for the client.
    isOwnRequest: (message) => ownRequests.has(message),
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
        refreshAll()
        return
      }
      toClient(message)
    }
  }
}

// Module resolution caches real package paths, so an install that upgrades the server would restart the old one.
// The root's node_modules link is followed again on every start.
function throughRootLink(root, server, program) {
  const link = join(root, 'node_modules', server === 'tsrs' ? 'tsrs' : 'typescript')
  try {
    const real = realpathSync(link)
    if (program.startsWith(real + sep)) {
      return join(link, program.slice(real.length + 1))
    }
  } catch {}
  return program
}

function runLanguageServer() {
  // resolve() drops the trailing separator the script-relative fallback carries.
  const root = resolve(
    process.env.CLAUDE_PROJECT_DIR || fileURLToPath(new URL('../../../..', import.meta.url))
  )
  let command
  let bridge
  const session = createServerSession({
    idleMs: resolveIdleMs(),
    isBackgroundRequest: (message) => bridge.isOwnRequest(message),
    onRestarted: () => bridge.refreshAll(),
    toClient: (message) => bridge.fromServer(message),
    onEnd: (code) => process.exit(code),
    startServer: ({ onMessage, onExit }) => {
      if (!command) {
        const { server, program, args, cwd } = resolveTypescriptLanguageServer({ root })
        const [launcher, ...rest] = args
        command = { program, args: [throughRootLink(root, server, launcher), ...rest], cwd }
      }
      const child = spawnProcess({ ...command, stdio: ['pipe', 'pipe', 'inherit'] })
      child.stdout.on('data', createLspMessageReader(onMessage))
      child.stdin.on('error', () => {})
      let exited = false
      const exitOnce = (code, signal) => {
        if (!exited) {
          exited = true
          onExit(code, signal)
        }
      }
      // A spawn error emits no exit; reporting it as one lets a failed restart retry instead of ending the session.
      child.on('error', (error) => {
        console.error(`agent-typescript-lsp: ${error.message}`)
        exitOnce(1, null)
      })
      child.on('exit', exitOnce)
      return {
        write: (message) => {
          if (child.stdin.writable) {
            child.stdin.write(encodeLspMessage(message))
          }
        },
        end: () => child.stdin.end(),
        kill: (signal) => {
          // Closing stdin ends a native server the launcher started as its own child (the Windows tsc path).
          child.stdin.destroy()
          if (process.platform === 'win32') {
            void signalProcessTree(child, signal)
          } else {
            child.kill(signal)
          }
        }
      }
    }
  })
  bridge = createDiagnosticsBridge({
    toClient: (message) => process.stdout.write(encodeLspMessage(message)),
    toServer: (message) => session.fromClient(message)
  })
  process.stdin.on(
    'data',
    createLspMessageReader((message) => bridge.fromClient(message))
  )
  // The client owns the session: when it goes away, so does the server.
  process.stdin.on('end', () => session.close())
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(signal, () => session.kill(signal))
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runLanguageServer()
}
