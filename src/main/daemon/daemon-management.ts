import { DegradedDaemonPtyProvider } from './providers/routing/degraded-daemon-pty-provider'
import type { DaemonPtyAdapter } from './providers/adapter/daemon-pty-adapter'
import {
  getAllDaemonAdapters,
  getCurrentDaemonAdapter,
  type DaemonProvider
} from './providers/lifecycle/daemon-provider-routing'
import { getDaemonProvider } from './providers/lifecycle/daemon-provider-state'
import type { DaemonEndpointIdentity } from './protocol/daemon-hello-protocol'
import type { DaemonSessionInfo } from './protocol/daemon-session-info'
import type { DaemonAsyncIoStatus } from '../../shared/terminal/daemon/daemon-async-io-health'

const MAX_POLL_ATTEMPTS = 65
const POLL_INTERVAL_MS = 100

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function daemonAdapters(provider: DaemonProvider | null): DaemonPtyAdapter[] {
  return provider ? [...getAllDaemonAdapters(provider)] : []
}

function currentDaemonIdentity(provider: DaemonProvider): DaemonEndpointIdentity | null {
  return getCurrentDaemonAdapter(provider).getDaemonIdentity()
}

export function isDaemonDegraded(provider = getDaemonProvider()): boolean {
  return (
    provider instanceof DegradedDaemonPtyProvider &&
    provider.routesFreshSpawnsToLocalProvider === true
  )
}

export async function listDaemonSessions(
  provider = getDaemonProvider()
): Promise<{ sessions: DaemonSessionInfo[]; degraded: boolean }> {
  const sessions = await collectDaemonSessions(daemonAdapters(provider))
  return { sessions, degraded: isDaemonDegraded(provider) }
}

export async function readDaemonAsyncIoHealth(
  provider = getDaemonProvider()
): Promise<DaemonAsyncIoStatus> {
  if (!provider) {
    return { state: 'unverifiable' }
  }
  const adapter = getCurrentDaemonAdapter(provider)
  const identity = currentDaemonIdentity(provider)
  const health = await adapter.getAsyncIoHealth()
  // A result from a replaced endpoint cannot diagnose its successor.
  return identity &&
    currentDaemonIdentity(provider) === identity &&
    getDaemonProvider() === provider
    ? health
    : { state: 'unverifiable' }
}

export async function killAllDaemonSessions(provider = getDaemonProvider()): Promise<{
  killedCount: number
  remainingCount: number
  killedSessionIds: string[]
}> {
  const adapters = daemonAdapters(provider)
  const initial = await collectDaemonSessions(adapters)
  const initialIds = new Set(initial.map((session) => session.sessionId))
  const initialCount = initial.length

  if (initialCount === 0) {
    return { killedCount: 0, remainingCount: 0, killedSessionIds: [] }
  }

  await Promise.allSettled(
    initial.map(async (session) => {
      const owner = adapters.find((adapter) => adapter.protocolVersion === session.protocolVersion)
      if (owner) {
        await owner.shutdown(session.sessionId, { immediate: true }).catch(() => {})
      }
    })
  )

  let remainingOriginalIds = initialIds
  for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt += 1) {
    await sleep(POLL_INTERVAL_MS)
    const current = await collectDaemonSessions(adapters)
    remainingOriginalIds = new Set(
      current
        .filter((session) => initialIds.has(session.sessionId))
        .map((session) => session.sessionId)
    )
    if (remainingOriginalIds.size === 0) {
      break
    }
  }

  return {
    killedCount: initialCount - remainingOriginalIds.size,
    remainingCount: remainingOriginalIds.size,
    killedSessionIds: [...initialIds].filter((sessionId) => !remainingOriginalIds.has(sessionId))
  }
}

export async function killDaemonSession(
  sessionId: string,
  provider = getDaemonProvider()
): Promise<{ success: boolean }> {
  if (sessionId.length === 0) {
    return { success: false }
  }
  const adapters = daemonAdapters(provider)
  const session = (await collectDaemonSessions(adapters)).find(
    (candidate) => candidate.sessionId === sessionId
  )
  if (!session) {
    return { success: false }
  }
  const owner = adapters.find((adapter) => adapter.protocolVersion === session.protocolVersion)
  if (!owner) {
    return { success: false }
  }
  try {
    await owner.shutdown(sessionId, { immediate: true })
    return { success: true }
  } catch {
    return { success: false }
  }
}

async function collectDaemonSessions(adapters: DaemonPtyAdapter[]): Promise<DaemonSessionInfo[]> {
  const results = await Promise.allSettled(
    adapters.map(async (adapter) => {
      const sessions = await adapter.listSessions()
      return sessions.map<DaemonSessionInfo>((session) => ({
        ...session,
        protocolVersion: adapter.protocolVersion
      }))
    })
  )
  return results.flatMap((result) => (result.status === 'fulfilled' ? result.value : []))
}
