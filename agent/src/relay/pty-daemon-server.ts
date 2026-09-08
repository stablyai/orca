/**
 * pty-daemon-server.ts — The detached PTY daemon process itself.
 *
 * Why this exists: pty-agent-bridge.ts's PTYs used to live in the agent's own
 * process memory, so an agent restart (deploy, systemd restart, crash) killed
 * every terminal outright. This daemon is a separate OS process — spawned
 * detached from the agent, NOT part of its process group — that holds the
 * real node-pty instances instead. The agent becomes a thin client
 * (pty-daemon-client.ts) that reconnects to this already-running daemon after
 * a restart, so terminals survive exactly like an SSH relay's PTYs survive an
 * SSH channel drop — because nothing here is tied to the connection anymore.
 *
 * Lifecycle:
 *   - Self-deduplicating startup: before binding the socket, probe it as a
 *     client first. If something is already listening, this process is a
 *     redundant spawn (e.g. two concurrent agent PTY requests both decided
 *     "not running") — exit(0) immediately and let the original keep serving.
 *   - Idle shutdown: exits after PTY_DAEMON_IDLE_SHUTDOWN_MS with zero PTYs
 *     and zero connected clients, so a Dev Server that stops using terminals
 *     doesn't carry a forever-running process for no reason.
 *   - Grace-period-on-agent-disconnect logic (scheduleGracePeriodCleanup)
 *     moves here unchanged from pty-agent-bridge.ts's exports — it now
 *     protects against "the WS to Orca closed" rather than "the daemon's
 *     client socket closed": the client (agent) calls daemon.sessionClosed
 *     when ITS ws to Orca drops; a mere client-socket disconnect (the agent
 *     process itself restarting) does NOT start any grace period, since that
 *     carries no information about whether the user is still using the
 *     terminal — the whole point of this daemon is to be indifferent to it.
 */
import * as net from 'node:net'
import * as fs from 'node:fs'
import type { AgentLogger } from './agent-logger'
import {
  handlePtyCreate,
  handlePtyAttach,
  handlePtyWrite,
  handlePtyResize,
  handlePtyDestroy,
  handlePtyScrollback,
  handlePtySendSignal,
  handlePtyListProcesses,
  scheduleGracePeriodCleanup,
  cleanupAgentPtys,
  activePtyCount
} from './pty-agent-bridge'
import {
  DaemonMessageDecoder,
  encodeDaemonMessage,
  isDaemonRequest,
  type DaemonMessage,
  type DaemonResponse
} from './pty-daemon-protocol'

const PTY_DAEMON_IDLE_SHUTDOWN_MS = 10 * 60_000
const PROBE_TIMEOUT_MS = 1_500

/** Narrows a pty-agent-bridge handler's loosely-typed JSON-RPC-shaped return
 *  value down to the daemon protocol's simpler {result?, error?} shape. */
function toDaemonOutcome(handlerResult: object): { result?: unknown; error?: { message: string } } {
  const shaped = handlerResult as { result?: unknown; error?: { message?: unknown } }
  if (shaped.error) {
    return {
      error: {
        message: typeof shaped.error.message === 'string' ? shaped.error.message : 'Unknown error'
      }
    }
  }
  return { result: shaped.result }
}

async function dispatchDaemonRequest(
  method: string,
  params: Record<string, unknown>,
  log: AgentLogger,
  notify: (method: string, params: Record<string, unknown>) => void
): Promise<{ result?: unknown; error?: { message: string } }> {
  switch (method) {
    case 'pty.create':
      return toDaemonOutcome(await handlePtyCreate(null, params, log, notify))
    case 'pty.attach':
      return toDaemonOutcome(await handlePtyAttach(null, params, log, notify))
    case 'pty.write':
      return toDaemonOutcome(await handlePtyWrite(null, params, log))
    case 'pty.resize':
      return toDaemonOutcome(await handlePtyResize(null, params, log))
    case 'pty.destroy':
      return toDaemonOutcome(await handlePtyDestroy(null, params, log))
    case 'pty.scrollback':
      return toDaemonOutcome(await handlePtyScrollback(null, params, log))
    case 'pty.sendSignal':
      return toDaemonOutcome(await handlePtySendSignal(null, params, log))
    case 'pty.listProcesses':
      return toDaemonOutcome(await handlePtyListProcesses(null, params, log))
    case 'daemon.ping':
      return { result: { ok: true, ptys: activePtyCount() } }
    case 'daemon.sessionClosed':
      scheduleGracePeriodCleanup(log)
      return { result: { ok: true } }
    case 'daemon.sessionTeardown':
      // CR-STORAGE-008(a)/TASK-AG-STORAGE-007: confirmed logout — unlike
      // daemon.sessionClosed (arms a grace period), this kills every
      // terminal PTY immediately, bypassing any grace timer already
      // counting down. cleanupAgentPtys() already clears graceTimer for
      // each entry before killing it (see pty-agent-bridge.ts), so no
      // separate "cancel timers first" step is needed here.
      cleanupAgentPtys(log)
      return { result: { ok: true } }
    default:
      return { error: { message: `Unknown daemon method: ${method}` } }
  }
}

function probeExistingDaemon(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.createConnection(socketPath)
    const timer = setTimeout(() => {
      sock.destroy()
      resolve(false)
    }, PROBE_TIMEOUT_MS)
    sock.once('connect', () => {
      clearTimeout(timer)
      sock.end()
      resolve(true)
    })
    sock.once('error', () => {
      clearTimeout(timer)
      resolve(false)
    })
  })
}

export async function runPtyDaemon(socketPath: string, log: AgentLogger): Promise<void> {
  if (await probeExistingDaemon(socketPath)) {
    log.info(`pty-daemon: another instance is already listening on ${socketPath} — exiting`)
    process.exit(0)
  }
  try {
    fs.unlinkSync(socketPath)
  } catch {
    // fine — either never existed, or was a stale file we're about to replace
  }

  const clients = new Set<net.Socket>()
  let idleTimer: ReturnType<typeof setTimeout> | null = null

  const broadcast = (method: string, params: Record<string, unknown>): void => {
    const line = encodeDaemonMessage({ method, params })
    for (const client of clients) {
      client.write(line)
    }
  }

  const armIdleShutdownIfEmpty = (): void => {
    if (idleTimer) {
      clearTimeout(idleTimer)
    }
    idleTimer = null
    if (clients.size > 0 || activePtyCount() > 0) {
      return
    }
    idleTimer = setTimeout(() => {
      if (clients.size === 0 && activePtyCount() === 0) {
        log.info('pty-daemon: idle with no PTYs and no clients — shutting down')
        server.close(() => process.exit(0))
      }
    }, PTY_DAEMON_IDLE_SHUTDOWN_MS)
  }

  const server = net.createServer((socket) => {
    clients.add(socket)
    if (idleTimer) {
      clearTimeout(idleTimer)
      idleTimer = null
    }
    const decoder = new DaemonMessageDecoder((msg: DaemonMessage) => {
      if (!isDaemonRequest(msg)) {
        return
      }
      void dispatchDaemonRequest(msg.method, msg.params ?? {}, log, broadcast)
        .then((outcome) => {
          const response: DaemonResponse = { id: msg.id, ...outcome }
          socket.write(encodeDaemonMessage(response))
        })
        .catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err)
          socket.write(encodeDaemonMessage({ id: msg.id, error: { message } }))
        })
    })
    socket.on('data', (chunk) => decoder.feed(chunk.toString('utf8')))
    socket.on('close', () => {
      clients.delete(socket)
      armIdleShutdownIfEmpty()
    })
    socket.on('error', () => {
      clients.delete(socket)
      armIdleShutdownIfEmpty()
    })
  })

  server.listen(socketPath, () => {
    log.info(`pty-daemon: listening on ${socketPath} (pid=${process.pid})`)
  })

  const shutdown = (signal: string): void => {
    log.info(`pty-daemon: shutting down (${signal})`)
    cleanupAgentPtys(log)
    server.close(() => process.exit(0))
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))

  armIdleShutdownIfEmpty()
}
