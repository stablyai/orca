import { existsSync } from 'fs'
import { join } from 'path'
import { DaemonClient } from '../../main/daemon/client'
import { getDaemonSocketPath, getDaemonTokenPath } from '../../main/daemon/daemon-spawner'
import type { ListSessionsResult, SessionInfo } from '../../main/daemon/types'

const KILL_SETTLE_POLL_MS = 100
const KILL_SETTLE_ATTEMPTS = 65

export type LocalDaemonStatus = {
  reachable: boolean
  sessionCount: number
}

export type LocalDaemonStopAllResult = {
  stopped: number
  remaining: number
}

function getRuntimeDir(userDataPath: string): string {
  return join(userDataPath, 'daemon')
}

function endpointExists(socketPath: string, tokenPath: string): boolean {
  if (!existsSync(tokenPath)) {
    return false
  }
  if (process.platform !== 'win32' && !existsSync(socketPath)) {
    return false
  }
  return true
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function withCurrentDaemonClient<T>(
  userDataPath: string,
  fn: (client: DaemonClient) => Promise<T>
): Promise<T | null> {
  const runtimeDir = getRuntimeDir(userDataPath)
  const socketPath = getDaemonSocketPath(runtimeDir)
  const tokenPath = getDaemonTokenPath(runtimeDir)
  if (!endpointExists(socketPath, tokenPath)) {
    return null
  }

  const client = new DaemonClient({ socketPath, tokenPath })
  try {
    await client.ensureConnected()
    return await fn(client)
  } catch {
    return null
  } finally {
    client.disconnect()
  }
}

async function listLiveSessions(client: DaemonClient): Promise<SessionInfo[]> {
  const result = await client.request<ListSessionsResult>('listSessions', undefined)
  return result.sessions.filter((session) => session.isAlive)
}

export async function getLocalDaemonStatus(userDataPath: string): Promise<LocalDaemonStatus> {
  const sessions = await withCurrentDaemonClient(userDataPath, listLiveSessions)
  return {
    reachable: sessions !== null,
    sessionCount: sessions?.length ?? 0
  }
}

export async function stopAllLocalDaemonSessions(
  userDataPath: string
): Promise<LocalDaemonStopAllResult> {
  const result = await withCurrentDaemonClient(userDataPath, async (client) => {
    const initial = await listLiveSessions(client)
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
      const current = await listLiveSessions(client).catch(() => [])
      remaining = current.reduce(
        (count, session) => (initialIds.has(session.sessionId) ? count + 1 : count),
        0
      )
      if (remaining === 0) {
        break
      }
    }

    return { stopped: initialIds.size - remaining, remaining }
  })

  return result ?? { stopped: 0, remaining: 0 }
}
