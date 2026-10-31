import type { DaemonClient } from './client'
import type { DaemonAsyncIoHealth, DaemonAsyncIoStatus } from '../../shared/daemon-async-io-health'
import { observeDaemonAsyncIoHealth } from './daemon-async-io-telemetry-event'
import { sameEndpointIdentity } from './daemon-endpoint-incarnation'
import { isUnknownRequestTypeError } from './daemon-endpoint-errors'

export async function readDaemonAsyncIoHealth(
  getClient: () => DaemonClient,
  protocolVersion: number
): Promise<DaemonAsyncIoStatus> {
  if (!getClient().isConnected()) {
    return { state: 'unverifiable' }
  }
  const identity = getClient().getDaemonIdentity()
  try {
    const health = await getClient().request<unknown>('asyncIoHealth', undefined, 7_000)
    if (
      health &&
      typeof health === 'object' &&
      'state' in health &&
      (health.state === 'healthy' || health.state === 'stalled') &&
      'pendingMs' in health &&
      typeof health.pendingMs === 'number' &&
      Number.isFinite(health.pendingMs) &&
      health.pendingMs >= 0
    ) {
      const result: DaemonAsyncIoHealth = { state: health.state, pendingMs: health.pendingMs }
      // A reply that crossed a reconnect cannot be attributed to either incarnation.
      const current = getClient().getDaemonIdentity()
      if (identity && current && sameEndpointIdentity(identity, current)) {
        observeDaemonAsyncIoHealth(identity, protocolVersion, result)
      }
      return result
    }
  } catch (error) {
    if (isUnknownRequestTypeError(error)) {
      return { state: 'unsupported' }
    }
  }
  return { state: 'unverifiable' }
}
