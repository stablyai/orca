import type { DaemonAsyncIoStatus } from '../../shared/daemon-async-io-health'
import { sameEndpointIdentity } from './daemon-endpoint-incarnation'
import { DegradedDaemonPtyProvider } from './degraded-daemon-pty-provider'
import { getAllDaemonAdapters, getCurrentDaemonAdapter } from './daemon-provider-routing'
import { getDaemonProvider } from './daemon-provider-state'

export async function readDaemonProviderAsyncIoHealth(): Promise<DaemonAsyncIoStatus> {
  const provider = getDaemonProvider()
  if (!provider) {
    return { state: 'unverifiable' }
  }
  const results = new Map(
    await Promise.all(
      getAllDaemonAdapters(provider).map(async (adapter) => {
        const identity = adapter.getDaemonIdentity()
        const health = await adapter
          .getAsyncIoHealth()
          .catch((): DaemonAsyncIoStatus => ({ state: 'unverifiable' }))
        return [adapter, { identity, health }] as const
      })
    )
  )
  if (getDaemonProvider() !== provider) {
    return { state: 'unverifiable' }
  }
  const health = getAllDaemonAdapters(provider).map((adapter): DaemonAsyncIoStatus => {
    const result = results.get(adapter)
    const identity = adapter.getDaemonIdentity()
    // Removed owners cannot warn; new or replaced owners cannot inherit health evidence.
    return result?.identity && identity && sameEndpointIdentity(result.identity, identity)
      ? {
          ...result.health,
          ...(result.health.state === 'stalled' &&
          provider instanceof DegradedDaemonPtyProvider &&
          adapter === getCurrentDaemonAdapter(provider)
            ? { recoverySupported: false }
            : {}),
          ...(result.health.state === 'stalled' &&
          Number.isSafeInteger(adapter.protocolVersion) &&
          Number.isFinite(result.identity.startedAtMs) &&
          result.identity.launchNonce
            ? {
                owner: {
                  protocolVersion: adapter.protocolVersion,
                  pid: result.identity.pid,
                  startedAtMs: result.identity.startedAtMs,
                  launchNonce: result.identity.launchNonce
                }
              }
            : {})
        }
      : { state: 'unverifiable' }
  })
  const stalled = health.find((result) => result.state === 'stalled')
  if (stalled) {
    return stalled
  }
  if (health.length === 0 || health.some((result) => result.state === 'unverifiable')) {
    return { state: 'unverifiable' }
  }
  const healthyPendingMs = health.flatMap((result) =>
    result.state === 'healthy' ? [result.pendingMs] : []
  )
  // Old peers cannot report a stall; they must not pin a recovered owner's warning forever.
  if (healthyPendingMs.length === 0) {
    return { state: 'unsupported' }
  }
  return {
    state: 'healthy',
    pendingMs: Math.max(...healthyPendingMs)
  }
}
