import type { EventProps } from '../../../shared/telemetry-events'
import { track } from '../../telemetry/client'

type OutboundBudgetEmitter = EventProps<'remote_outbound_budget_close'>['emitter']

export function trackRemoteOutboundBudgetClose(emitter: OutboundBudgetEmitter): void {
  try {
    track('remote_outbound_budget_close', { emitter })
  } catch {
    // Telemetry must not prevent closing an unsafe socket.
  }
}
