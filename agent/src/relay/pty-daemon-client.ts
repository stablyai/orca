/**
 * pty-daemon-client.ts — Agent-side client for the detached pty-daemon
 * process (pty-daemon-server.ts). See that file for why PTYs live there
 * instead of in the agent's own process.
 *
 * Exports the same handler shape agent-rpc-dispatch.ts already calls
 * (id, params, log, notify) → JSON-RPC-shaped response, so swapping the
 * import from './pty-agent-bridge' to './pty-daemon-client' is the only
 * change needed at each call site. Every exported function updates the
 * "current notify" reference (see below) even ones that don't themselves
 * produce a push — the daemon can emit pty.data/pty.exit/pty.replay for ANY
 * live PTY at any time, independent of which request most recently arrived,
 * so whichever WebSocket connection is current must always be reachable.
 */
import * as net from 'node:net'
import * as path from 'node:path'
import * as os from 'node:os'
import * as fs from 'node:fs'
import { spawn } from 'node:child_process'
import type { AgentLogger } from './agent-logger'
import {
  DaemonMessageDecoder,
  encodeDaemonMessage,
  isDaemonResponse,
  type DaemonMessage
} from './pty-daemon-protocol'

const REQUEST_TIMEOUT_MS = 15_000
const CONNECT_TIMEOUT_MS = 2_000
const SPAWN_WAIT_TIMEOUT_MS = 5_000
const SPAWN_WAIT_POLL_MS = 100

type PendingRequest = {
  resolve: (v: { result?: unknown; error?: { message: string } }) => void
  reject: (err: Error) => void
}
type NotifyFn = (method: string, params: Record<string, unknown>) => void

let socket: net.Socket | null = null
let connectingPromise: Promise<net.Socket> | null = null
let nextRequestId = 1
const pendingRequests = new Map<number, PendingRequest>()
/** Always the notify callback bound to whichever WebSocket connection to
 *  Orca is current — rebound on every dispatch call (see the exported
 *  handlers below), so a daemon push always reaches the live connection. */
let currentNotify: NotifyFn | null = null

export function getDaemonSocketPath(): string {
  return path.join(os.homedir(), 'orca-agent', 'pty-daemon.sock')
}

function tryConnect(socketPath: string, timeoutMs: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(socketPath)
    const timer = setTimeout(() => {
      sock.destroy()
      reject(new Error(`pty-daemon connect timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    sock.once('connect', () => {
      clearTimeout(timer)
      resolve(sock)
    })
    sock.once('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
  })
}

function getDaemonLogPath(): string {
  return path.join(os.homedir(), 'orca-agent', 'logs', 'pty-daemon.log')
}

function spawnDaemon(socketPath: string, log: AgentLogger): void {
  log.info(`pty-daemon-client: spawning daemon (socket=${socketPath})`)
  // Why a log file, not 'ignore': this process is detached and unref'd —
  // nothing else will ever read its stdout/stderr, so 'ignore' would silently
  // discard every log line the daemon ever prints, making it undebuggable.
  const logPath = getDaemonLogPath()
  fs.mkdirSync(path.dirname(logPath), { recursive: true })
  const logFd = fs.openSync(logPath, 'a')
  const child = spawn(process.execPath, [process.argv[1]!], {
    env: { ...process.env, ORCA_PTY_DAEMON_SOCKET: socketPath },
    detached: true,
    stdio: ['ignore', logFd, logFd]
  })
  child.unref()
  fs.closeSync(logFd) // the child holds its own fd table entry; safe to close ours
}

async function waitForDaemonReady(socketPath: string, log: AgentLogger): Promise<net.Socket> {
  const deadline = Date.now() + SPAWN_WAIT_TIMEOUT_MS
  let lastErr: unknown = null
  while (Date.now() < deadline) {
    try {
      return await tryConnect(socketPath, CONNECT_TIMEOUT_MS)
    } catch (err) {
      lastErr = err
      await new Promise((r) => setTimeout(r, SPAWN_WAIT_POLL_MS))
    }
  }
  const msg = lastErr instanceof Error ? lastErr.message : String(lastErr)
  log.error(`pty-daemon-client: daemon never became ready: ${msg}`)
  throw new Error(`pty-daemon did not become ready: ${msg}`)
}

function wireSocket(sock: net.Socket): void {
  const decoder = new DaemonMessageDecoder((msg: DaemonMessage) => {
    if (isDaemonResponse(msg)) {
      const pending = pendingRequests.get(msg.id)
      if (!pending) {
        return
      }
      pendingRequests.delete(msg.id)
      if (msg.error) {
        pending.reject(new Error(msg.error.message))
      } else {
        pending.resolve({ result: msg.result })
      }
      return
    }
    // Notification: { method, params }, no id.
    if ('method' in msg && !('id' in msg)) {
      currentNotify?.(msg.method, msg.params)
    }
  })
  sock.on('data', (chunk) => decoder.feed(chunk.toString('utf8')))
  const onDrop = (): void => {
    if (socket === sock) {
      socket = null
    }
    for (const [id, pending] of pendingRequests) {
      pending.reject(new Error('pty-daemon connection lost'))
      pendingRequests.delete(id)
    }
  }
  sock.on('close', onDrop)
  sock.on('error', onDrop)
}

async function ensureConnection(log: AgentLogger): Promise<net.Socket> {
  if (socket && !socket.destroyed) {
    return socket
  }
  if (connectingPromise) {
    return connectingPromise
  }
  connectingPromise = (async () => {
    const socketPath = getDaemonSocketPath()
    let sock: net.Socket
    try {
      sock = await tryConnect(socketPath, CONNECT_TIMEOUT_MS)
    } catch {
      spawnDaemon(socketPath, log)
      sock = await waitForDaemonReady(socketPath, log)
    }
    wireSocket(sock)
    socket = sock
    return sock
  })()
  try {
    return await connectingPromise
  } finally {
    connectingPromise = null
  }
}

async function sendRequest(
  method: string,
  params: Record<string, unknown>,
  log: AgentLogger
): Promise<{ result?: unknown; error?: { message: string } }> {
  const sock = await ensureConnection(log)
  const id = nextRequestId++
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingRequests.delete(id)
      reject(new Error(`pty-daemon request '${method}' timed out after ${REQUEST_TIMEOUT_MS}ms`))
    }, REQUEST_TIMEOUT_MS)
    pendingRequests.set(id, {
      resolve: (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      reject: (err) => {
        clearTimeout(timer)
        reject(err)
      }
    })
    sock.write(encodeDaemonMessage({ id, method, params }))
  })
}

async function forward(
  method: string,
  id: string | number | null,
  params: Record<string, unknown>,
  log: AgentLogger,
  notify?: NotifyFn
): Promise<object> {
  if (notify) {
    currentNotify = notify
  }
  try {
    const outcome = await sendRequest(method, params, log)
    if (outcome.error) {
      return { jsonrpc: '2.0', id, error: { code: -32603, message: outcome.error.message } }
    }
    return { jsonrpc: '2.0', id, result: outcome.result }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    return { jsonrpc: '2.0', id, error: { code: -32603, message: msg } }
  }
}

export async function handlePtyCreate(
  id: string | number | null,
  params: Record<string, unknown>,
  log: AgentLogger,
  notify: NotifyFn
): Promise<object> {
  return forward('pty.create', id, params, log, notify)
}

export async function handlePtyAttach(
  id: string | number | null,
  params: Record<string, unknown>,
  log: AgentLogger,
  notify: NotifyFn
): Promise<object> {
  return forward('pty.attach', id, params, log, notify)
}

export async function handlePtyWrite(
  id: string | number | null,
  params: Record<string, unknown>,
  log: AgentLogger,
  notify?: NotifyFn
): Promise<object> {
  return forward('pty.write', id, params, log, notify)
}

export async function handlePtyResize(
  id: string | number | null,
  params: Record<string, unknown>,
  log: AgentLogger,
  notify?: NotifyFn
): Promise<object> {
  return forward('pty.resize', id, params, log, notify)
}

export async function handlePtyDestroy(
  id: string | number | null,
  params: Record<string, unknown>,
  log: AgentLogger,
  notify?: NotifyFn
): Promise<object> {
  return forward('pty.destroy', id, params, log, notify)
}

export async function handlePtyScrollback(
  id: string | number | null,
  params: Record<string, unknown>,
  log: AgentLogger,
  notify?: NotifyFn
): Promise<object> {
  return forward('pty.scrollback', id, params, log, notify)
}

export async function handlePtySendSignal(
  id: string | number | null,
  params: Record<string, unknown>,
  log: AgentLogger,
  notify?: NotifyFn
): Promise<object> {
  return forward('pty.sendSignal', id, params, log, notify)
}

export async function handlePtyListProcesses(
  id: string | number | null,
  params: Record<string, unknown>,
  log: AgentLogger,
  notify?: NotifyFn
): Promise<object> {
  return forward('pty.listProcesses', id, params, log, notify)
}

/**
 * notifyDaemonSessionClosed — Called when the agent's WebSocket to Orca
 * closes. Tells the daemon to start grace-period timers for every live PTY
 * (see pty-agent-bridge.ts's scheduleGracePeriodCleanup) instead of killing
 * anything itself — the daemon, not the agent, owns that decision now.
 * Best-effort: if the daemon is unreachable there is nothing to protect.
 */
export async function notifyDaemonSessionClosed(log: AgentLogger): Promise<void> {
  try {
    await sendRequest('daemon.sessionClosed', {}, log)
  } catch {
    // best effort — a dead daemon has no PTYs to protect anyway
  }
}

/**
 * notifyDaemonSessionTeardown — CR-STORAGE-008(a)/TASK-AG-STORAGE-007's
 * confirmed-logout path. Tells the daemon to kill every terminal PTY NOW,
 * bypassing any grace period already counting down — the one case where
 * immediate cleanup (not "wait and see if the client reconnects") is
 * correct, because the caller has already confirmed this is intentional.
 * Best-effort like notifyDaemonSessionClosed: a dead daemon has nothing
 * left to tear down.
 */
export async function notifyDaemonSessionTeardown(log: AgentLogger): Promise<void> {
  try {
    await sendRequest('daemon.sessionTeardown', {}, log)
  } catch {
    // best effort — a dead daemon has no PTYs to protect anyway
  }
}
