import type {
  StalledDaemonOwner,
  StalledDaemonReview,
  StalledDaemonRestartRequest,
  StalledDaemonRestartResult
} from '../../shared/daemon-async-io-health'
import { getDaemonProvider } from './daemon-provider-state'
import { getAllDaemonAdapters, getCurrentDaemonAdapter } from './daemon-provider-routing'
import { DegradedDaemonPtyProvider } from './degraded-daemon-pty-provider'
import { DaemonPtyRouter } from './daemon-pty-router'
import { probeSocketConnect, endpointIsProvenDead } from './daemon-endpoint-probe'
import { getDaemonSocketPath } from './daemon-spawner'
import { getDaemonRuntimeDir } from './daemon-launch-paths'
import { replaceCurrentDaemonAfterVerifiedShutdown } from './daemon-provider-restart'
import { isDaemonRestartInFlight, runCoalescedDaemonRestart } from './daemon-restart-state'

function findOwner(owner: StalledDaemonOwner) {
  const provider = getDaemonProvider()
  if (!provider) {
    return null
  }
  const adapter = getAllDaemonAdapters(provider).find((adapter) => {
    const identity = adapter.getDaemonIdentity()
    return (
      adapter.protocolVersion === owner.protocolVersion &&
      identity?.pid === owner.pid &&
      identity.startedAtMs === owner.startedAtMs &&
      identity.launchNonce === owner.launchNonce
    )
  })
  if (
    provider instanceof DegradedDaemonPtyProvider &&
    adapter === getCurrentDaemonAdapter(provider)
  ) {
    return null
  }
  return adapter ? { provider, adapter } : null
}

export function isStalledDaemonOwner(value: unknown): value is StalledDaemonOwner {
  return (
    !!value &&
    typeof value === 'object' &&
    'protocolVersion' in value &&
    typeof value.protocolVersion === 'number' &&
    Number.isSafeInteger(value.protocolVersion) &&
    'pid' in value &&
    typeof value.pid === 'number' &&
    Number.isSafeInteger(value.pid) &&
    value.pid > 0 &&
    'startedAtMs' in value &&
    typeof value.startedAtMs === 'number' &&
    Number.isFinite(value.startedAtMs) &&
    'launchNonce' in value &&
    typeof value.launchNonce === 'string' &&
    value.launchNonce.length > 0
  )
}

export function isStalledDaemonRestartRequest(
  value: unknown
): value is StalledDaemonRestartRequest {
  return (
    !!value &&
    typeof value === 'object' &&
    'owner' in value &&
    isStalledDaemonOwner(value.owner) &&
    'sessions' in value &&
    Array.isArray(value.sessions) &&
    value.sessions.every(
      (session) =>
        !!session &&
        typeof session === 'object' &&
        typeof session.sessionId === 'string' &&
        typeof session.incarnationId === 'string' &&
        session.incarnationId.length > 0 &&
        (session.cwd === null || typeof session.cwd === 'string') &&
        (session.pid === null || typeof session.pid === 'number')
    )
  )
}

export async function reviewStalledDaemon(owner: StalledDaemonOwner): Promise<StalledDaemonReview> {
  const found = findOwner(owner)
  if (!found) {
    return { status: 'refused' }
  }
  try {
    const health = await found.adapter.getAsyncIoHealth()
    if (health.state !== 'stalled' || health.recoverySupported !== true) {
      return { status: 'refused' }
    }
    const sessions = (await found.adapter.listSessions()).filter(
      (session) => session.state !== 'exited'
    )
    if (
      findOwner(owner)?.adapter !== found.adapter ||
      getDaemonProvider() !== found.provider ||
      sessions.some((session) => !session.incarnationId)
    ) {
      return { status: 'refused' }
    }
    return {
      status: 'ready',
      owner,
      sessions: sessions.flatMap((session) =>
        session.incarnationId
          ? [
              {
                sessionId: session.sessionId,
                incarnationId: session.incarnationId,
                cwd: session.cwd,
                pid: session.pid
              }
            ]
          : []
      )
    }
  } catch {
    return { status: 'refused' }
  }
}

export async function restartStalledDaemon(
  request: StalledDaemonRestartRequest
): Promise<StalledDaemonRestartResult> {
  if (isDaemonRestartInFlight()) {
    return { status: 'refused' }
  }
  try {
    const result = await runCoalescedDaemonRestart(async () => {
      const outcome = await runStalledDaemonRecovery(request)
      if (outcome.status !== 'restarted') {
        throw new Error('Targeted recovery refused')
      }
      return { killedCount: outcome.killedCount }
    })
    return { status: 'restarted', killedCount: result.killedCount }
  } catch {
    return { status: 'refused' }
  }
}

async function runStalledDaemonRecovery(
  request: StalledDaemonRestartRequest
): Promise<StalledDaemonRestartResult> {
  const found = findOwner(request.owner)
  if (!found) {
    return { status: 'refused' }
  }
  const result = await found.adapter.shutdownStalledOwner(request)
  if (result.status !== 'restarted') {
    return result
  }
  const deadline = Date.now() + 5_000
  const socketPath = getDaemonSocketPath(getDaemonRuntimeDir(), request.owner.protocolVersion)
  while (!endpointIsProvenDead(await probeSocketConnect(socketPath))) {
    if (Date.now() >= deadline) {
      return { status: 'refused' }
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  if (getDaemonProvider() !== found.provider) {
    return { status: 'refused' }
  }
  if (found.adapter === getCurrentDaemonAdapter(found.provider)) {
    try {
      await replaceCurrentDaemonAfterVerifiedShutdown(request.owner.pid)
    } catch {
      return { status: 'refused' }
    }
  } else if (
    found.provider instanceof DaemonPtyRouter ||
    found.provider instanceof DegradedDaemonPtyProvider
  ) {
    found.provider.removeRecoveredLegacyAdapter(found.adapter)
    await found.adapter.disconnectOnly()
  }
  return result
}
