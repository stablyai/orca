import type { DaemonClient } from './client'
import type { DaemonAsyncIoHealth, DaemonAsyncIoStatus } from '../../shared/daemon-async-io-health'
import { isUnknownRequestTypeError } from './daemon-endpoint-errors'
import { observeDaemonAsyncIoHealth } from './daemon-async-io-telemetry-event'
import { sameEndpointIdentity } from './daemon-endpoint-incarnation'

export async function readDaemonAsyncIoHealth(
  client: Pick<DaemonClient, 'isConnected' | 'getDaemonIdentity' | 'request'>,
  getProtocolVersion: () => number
): Promise<DaemonAsyncIoStatus> {
  if (!client.isConnected()) {
    return { state: 'unverifiable' }
  }
  const identity = client.getDaemonIdentity()
  try {
    const health = await client.request<unknown>('asyncIoHealth', undefined, 7_000)
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
      const current = client.getDaemonIdentity()
      if (identity && current && sameEndpointIdentity(identity, current)) {
        observeDaemonAsyncIoHealth(identity, getProtocolVersion(), result)
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
