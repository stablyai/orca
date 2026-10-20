import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { DaemonClient } from '../../main/daemon/client'
import { isDaemonEndpointGoneError } from '../../main/daemon/daemon-errors'
import { getDaemonSocketPath, getDaemonTokenPath } from '../../main/daemon/daemon-spawner'
import type { ListSessionsResult, SessionInfo } from '../../main/daemon/types'
import { RuntimeClientError } from './types'

const KILL_SETTLE_POLL_MS = 100
const KILL_SETTLE_ATTEMPTS = 65
// Why: matches the runtime status.get budget so a wedged daemon cannot stall `orca status`.
const STATUS_PROBE_BUDGET_MS = 1000

export type LocalDaemonStatus = {
  reachable: boolean
  /** Null when a daemon may be live but its sessions could not be counted. */
  sessionCount: number | null
}

export type LocalDaemonStopAllResult = {
  stopped: number
  remaining: number
}

type DaemonEndpoint = {
  socketPath: string
  tokenPath: string
}

function findDaemonEndpoint(userDataPath: string): DaemonEndpoint | null {
  const runtimeDir = join(userDataPath, 'daemon')
  const socketPath = getDaemonSocketPath(runtimeDir)
  const tokenPath = getDaemonTokenPath(runtimeDir)
  if (!existsSync(tokenPath)) {
    return null
  }
  if (process.platform !== 'win32' && !existsSync(socketPath)) {
    return null
  }
  return { socketPath, tokenPath }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function listLiveSessions(client: DaemonClient, timeoutMs?: number): Promise<SessionInfo[]> {
  const result = await client.request<ListSessionsResult>('listSessions', undefined, timeoutMs)
  return result.sessions.filter((session) => session.isAlive)
}

export async function getLocalDaemonStatus(userDataPath: string): Promise<LocalDaemonStatus> {
  const endpoint = findDaemonEndpoint(userDataPath)
  if (!endpoint) {
    return { reachable: false, sessionCount: 0 }
  }
  const client = new DaemonClient(endpoint)
  const deadlineMs = Date.now() + STATUS_PROBE_BUDGET_MS
  try {
    try {
      await client.ensureConnectedWithin(STATUS_PROBE_BUDGET_MS)
    } catch (error) {
      return { reachable: false, sessionCount: isDaemonEndpointGoneError(error) ? 0 : null }
    }
    try {
      const sessions = await listLiveSessions(client, Math.max(1, deadlineMs - Date.now()))
      return { reachable: true, sessionCount: sessions.length }
    } catch {
      return { reachable: true, sessionCount: null }
    }
  } finally {
    client.disconnect()
  }
}

export async function stopAllLocalDaemonSessions(
  userDataPath: string
): Promise<LocalDaemonStopAllResult> {
  const endpoint = findDaemonEndpoint(userDataPath)
  if (!endpoint) {
    return { stopped: 0, remaining: 0 }
  }
  const client = new DaemonClient(endpoint)
  try {
    try {
      await client.ensureConnected()
    } catch (error) {
      // Why: a stale socket or Windows token file with no listener means no daemon, so nothing to stop.
      if (isDaemonEndpointGoneError(error)) {
        return { stopped: 0, remaining: 0 }
      }
      throw new RuntimeClientError(
        'daemon_unavailable',
        `Could not connect to the local terminal daemon: ${errorMessage(error)}`
      )
    }

    let initial: SessionInfo[]
    try {
      initial = await listLiveSessions(client)
    } catch (error) {
      throw new RuntimeClientError(
        'daemon_request_failed',
        `Could not list local terminal daemon sessions: ${errorMessage(error)}`
      )
    }
    const initialIds = new Set(initial.map((session) => session.sessionId))
    if (initialIds.size === 0) {
      return { stopped: 0, remaining: 0 }
    }

    await Promise.allSettled(
      initial.map((session) =>
        client.request('kill', { sessionId: session.sessionId, immediate: true }).catch(() => {})
      )
    )

    let remaining = initialIds.size
    for (let attempt = 0; attempt < KILL_SETTLE_ATTEMPTS; attempt += 1) {
      await delay(KILL_SETTLE_POLL_MS)
      let current: SessionInfo[]
      try {
        current = await listLiveSessions(client)
      } catch {
        // Why: losing the daemon is not proof its sessions exited; keep the last observed count.
        break
      }
      remaining = current.reduce(
        (count, session) => (initialIds.has(session.sessionId) ? count + 1 : count),
        0
      )
      if (remaining === 0) {
        break
      }
    }

    return { stopped: initialIds.size - remaining, remaining }
  } finally {
    client.disconnect()
  }
}
