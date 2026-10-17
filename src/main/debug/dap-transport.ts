import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { connect, isIP, type NetConnectOpts, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Readable, Writable } from 'node:stream'
import { spawnProcess } from '@orca/process-host'
import type { PipedChildProcess, ProcessSpec } from '@orca/process-host/process-spec'
import { signalProcessTree } from '@orca/process-host/process-tree-termination'
import { StderrRing } from './dap-protocol'

export { DAP_STDERR_RING_BYTES, StderrRing } from './dap-protocol'

export class DapTransportError extends Error {}

export const DAP_DEFAULT_CONNECT_TIMEOUT_MS = 5_000
export const DAP_DEFAULT_TCP_READY_DEADLINE_MS = 10_000
// Host may be bracketed IPv6; the greedy host leaves exactly the trailing `:port`.
export const JS_DEBUG_READY_PATTERN = /Debug server listening at \[?([^\s\]]+)\]?:(\d+)/
export const DLV_READY_PATTERN = /DAP server listening at:? \[?([^\s\]]+)\]?:(\d+)/
/** js-debug and dlv print the socket path they listen on; the dial still uses Orca's own path. */
export const SOCKET_READY_PATTERN = /server listening at:? (?:unix:)?(\S+)/
/** Stands in for the per-session socket path in adapter args, keys and the trust prompt. */
export const DAP_SOCKET_PLACEHOLDER = '<socket>'

const DIAL_RETRY_INTERVAL_MS = 50
const READY_SCAN_TAIL_BYTES = 16 * 1024
const RETRYABLE_DIAL_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOENT'])
// Each changes what code a process loads at startup; the adapter env never takes them from a caller.
const ADAPTER_ENV_DENIED = /^(NODE_OPTIONS|PYTHON(PATH|STARTUP|HOME)|LD_PRELOAD|DYLD_.*)$/i
const POSIX_ENV_ALLOWLIST = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'TERM', 'LANG']
// Why: without these a Windows child cannot open sockets or find its own profile.
const WIN32_ENV_ALLOWLIST = [
  'SystemRoot',
  'windir',
  'ComSpec',
  'PATHEXT',
  'TEMP',
  'TMP',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA'
]

export type DapEndpoint = { path: string } | { host: string; port: number }

export type DapTransport = {
  kind: 'stdio' | 'tcp' | 'socket'
  input: Readable
  output: Writable
  /** The adapter process this transport owns; null for a dial into an adapter owned elsewhere. */
  child: PipedChildProcess | null
  socket: Socket | null
  /** Where a child session dials the same adapter server; null for stdio. */
  endpoint: DapEndpoint | null
  stderr: StderrRing
  /** Removes what the transport created on disk (the socket directory); run after the adapter dies. */
  dispose?: () => void
}

export type DapAdapterSpec = {
  program: string
  args?: readonly string[]
  cwd?: string
  /** Orca-chosen additions to the allowlist; loader keys (NODE_OPTIONS, PYTHONPATH, ...) are dropped. */
  env?: Record<string, string>
  spawn?: (spec: ProcessSpec) => PipedChildProcess
}

/** An allowlist, never main's full environment: Orca's own secrets must not reach a debuggee. */
export function buildAdapterEnv(
  extra: Record<string, string> = {},
  base: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): NodeJS.ProcessEnv {
  const allowed = new Set(
    [...POSIX_ENV_ALLOWLIST, ...(platform === 'win32' ? WIN32_ENV_ALLOWLIST : [])].map((name) =>
      platform === 'win32' ? name.toUpperCase() : name
    )
  )
  const env: NodeJS.ProcessEnv = {}
  for (const [name, value] of Object.entries(base)) {
    const key = platform === 'win32' ? name.toUpperCase() : name
    if (value !== undefined && (allowed.has(key) || name.startsWith('LC_'))) {
      env[name] = value
    }
  }
  for (const [name, value] of Object.entries(extra)) {
    if (!ADAPTER_ENV_DENIED.test(name)) {
      env[name] = value
    }
  }
  return env
}

export function isLoopbackHost(host: string): boolean {
  const bare = host.replace(/^\[(.*)\]$/, '$1')
  if (bare === 'localhost') {
    return true
  }
  if (isIP(bare) === 4) {
    return bare.startsWith('127.')
  }
  return isIP(bare) === 6 && (bare === '::1' || /^::ffff:127\./i.test(bare))
}

function spawnAdapter(spec: DapAdapterSpec): {
  child: PipedChildProcess
  stderr: StderrRing
} {
  const child = (spec.spawn ?? spawnProcess)({
    program: spec.program,
    args: spec.args,
    cwd: spec.cwd,
    env: buildAdapterEnv(spec.env),
    // Own process group so close can kill the debuggee the adapter spawned; Windows kills by tree.
    detached: process.platform !== 'win32'
  })
  const stderr = new StderrRing()
  child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
  // An unhandled pipe 'error' is an uncaught exception in main; the exit path reports the failure.
  child.stdin.on('error', () => {})
  child.stdout.on('error', () => {})
  child.stderr.on('error', () => {})
  return { child, stderr }
}

export function spawnStdioAdapter(spec: DapAdapterSpec): DapTransport {
  const { child, stderr } = spawnAdapter(spec)
  return {
    kind: 'stdio',
    input: child.stdout,
    output: child.stdin,
    child,
    socket: null,
    endpoint: null,
    stderr
  }
}

const describeEndpoint = (to: DapEndpoint): string =>
  'path' in to ? to.path : `${to.host}:${to.port}`

function dialOnce(to: DapEndpoint, timeoutMs: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const options: NetConnectOpts =
      'path' in to ? { path: to.path } : { host: to.host, port: to.port }
    const socket = connect(options)
    const timer = setTimeout(() => {
      socket.destroy()
      reject(
        Object.assign(new Error(`connect to ${describeEndpoint(to)} timed out`), {
          code: 'ETIMEDOUT'
        })
      )
    }, timeoutMs)
    socket.once('connect', () => {
      clearTimeout(timer)
      socket.removeAllListeners('error')
      // Covers the gap until the connection attaches its own listener.
      socket.on('error', () => {})
      resolve(socket)
    })
    socket.once('error', (error) => {
      clearTimeout(timer)
      socket.destroy()
      reject(error)
    })
  })
}

function dialHost(host: string): string {
  if (!isLoopbackHost(host)) {
    throw new DapTransportError(`refusing to dial non-loopback debug adapter host ${host}`)
  }
  const bare = host.replace(/^\[(.*)\]$/, '$1')
  return bare === 'localhost' ? '127.0.0.1' : bare
}

/** One dial into an already-listening adapter, e.g. js-debug's second connection for a child session. */
export async function connectTcpAdapter(options: {
  port: number
  host?: string
  connectTimeoutMs?: number
}): Promise<DapTransport> {
  const endpoint = { host: dialHost(options.host ?? '127.0.0.1'), port: options.port }
  return dialedTransport(endpoint, options.connectTimeoutMs)
}

/** One dial into an adapter's socket, e.g. js-debug's second connection for a child session. */
export function connectSocketAdapter(options: {
  path: string
  connectTimeoutMs?: number
}): Promise<DapTransport> {
  return dialedTransport({ path: options.path }, options.connectTimeoutMs)
}

async function dialedTransport(endpoint: DapEndpoint, timeoutMs?: number): Promise<DapTransport> {
  const socket = await dialOnce(endpoint, timeoutMs ?? DAP_DEFAULT_CONNECT_TIMEOUT_MS)
  const kind = 'path' in endpoint ? 'socket' : 'tcp'
  return {
    kind,
    input: socket,
    output: socket,
    child: null,
    socket,
    endpoint,
    stderr: new StderrRing()
  }
}

async function dialWithRetry(
  to: DapEndpoint,
  deadline: number,
  gaveUp: () => string | null
): Promise<Socket> {
  for (;;) {
    const remaining = deadline - Date.now()
    try {
      return await dialOnce(to, Math.max(1, Math.min(remaining, 2_000)))
    } catch (error) {
      const code = error instanceof Error && 'code' in error ? String(error.code) : ''
      const stop = gaveUp()
      if (
        stop ||
        !RETRYABLE_DIAL_CODES.has(code) ||
        Date.now() + DIAL_RETRY_INTERVAL_MS > deadline
      ) {
        throw new DapTransportError(
          stop ?? `could not connect to ${describeEndpoint(to)}: ${code || String(error)}`
        )
      }
      await new Promise((resolve) => setTimeout(resolve, DIAL_RETRY_INTERVAL_MS))
    }
  }
}

/**
 * Spawns a TCP-serving adapter, reads the port from its listening line, then dials it.
 * Why not bind :0 and pass the port in: that races another process for the port.
 */
export function spawnTcpAdapter(
  spec: DapAdapterSpec,
  readyPattern: RegExp,
  options: { deadlineMs?: number } = {}
): Promise<DapTransport> {
  return spawnListeningAdapter(spec, readyPattern, options, (match) => ({
    host: dialHost(match[1]),
    port: Number(match[2])
  }))
}

/**
 * Spawns an adapter on a unix socket (a named pipe on Windows) in a fresh 0700 directory.
 * Why not loopback TCP: js-debug's server takes any local connection's `launch`, with no token.
 */
export function spawnSocketAdapter(
  spec: DapAdapterSpec,
  options: { deadlineMs?: number } = {}
): Promise<DapTransport> {
  const dir = process.platform === 'win32' ? null : mkdtempSync(join(tmpdir(), 'orca-dap-'))
  const path = dir ? join(dir, 'dap.sock') : `\\\\.\\pipe\\orca-dap-${randomUUID()}`
  const dispose = (): void => {
    if (dir) {
      rmSync(dir, { recursive: true, force: true })
    }
  }
  const args = (spec.args ?? []).map((arg) => arg.replaceAll(DAP_SOCKET_PLACEHOLDER, path))
  const started = spawnListeningAdapter(
    { ...spec, args },
    SOCKET_READY_PATTERN,
    options,
    (match) => {
      if (match[1] !== path) {
        throw new DapTransportError(`debug adapter listens on ${match[1]}, not ${path}`)
      }
      return { path }
    }
  )
  return started.then(
    (transport) => ({ ...transport, kind: 'socket', dispose }),
    (error: unknown) => {
      dispose()
      throw error
    }
  )
}

async function spawnListeningAdapter(
  spec: DapAdapterSpec,
  readyPattern: RegExp,
  options: { deadlineMs?: number },
  endpointOf: (match: RegExpExecArray) => DapEndpoint
): Promise<DapTransport> {
  const deadline = Date.now() + (options.deadlineMs ?? DAP_DEFAULT_TCP_READY_DEADLINE_MS)
  const { child, stderr } = spawnAdapter(spec)
  let exitReason: string | null = null
  const describeExit = (): string | null =>
    exitReason && `debug adapter ${exitReason}: ${stderr.text().trim().slice(-1024)}`
  child.on('error', (error) => (exitReason ??= `failed to start (${error.message})`))
  child.on('exit', (code, signal) => (exitReason ??= `exited with ${signal ?? code}`))
  try {
    const match = await new Promise<RegExpExecArray>((resolve, reject) => {
      let scanned = ''
      let ready = false
      const timer = setTimeout(
        () => reject(new DapTransportError('debug adapter never printed its listening line')),
        Math.max(0, deadline - Date.now())
      )
      // Why keep listening after the match: an undrained stdout pipe blocks the adapter mid-write.
      child.stdout.on('data', (chunk: Buffer) => {
        if (ready) {
          return
        }
        scanned = (scanned + chunk.toString('utf8')).slice(-READY_SCAN_TAIL_BYTES)
        const found = readyPattern.exec(scanned)
        if (found) {
          ready = true
          clearTimeout(timer)
          resolve(found)
        }
      })
      child.once('exit', () => {
        clearTimeout(timer)
        reject(new DapTransportError(describeExit() ?? 'debug adapter exited'))
      })
      child.once('error', () => {
        clearTimeout(timer)
        reject(new DapTransportError(describeExit() ?? 'debug adapter failed to start'))
      })
    })
    const endpoint = endpointOf(match)
    const socket = await dialWithRetry(endpoint, deadline, describeExit)
    return { kind: 'tcp', input: socket, output: socket, child, socket, endpoint, stderr }
  } catch (error) {
    void signalProcessTree(child, 'SIGKILL')
    throw error
  }
}
