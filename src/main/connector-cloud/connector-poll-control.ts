import { delayUnlessAborted } from '../../shared/concurrency/abort-aware-delay'
import { ConnectorPollControl } from '../../shared/connectors/connector-cloud-contract'
import type { ConnectorFailure } from './connector-cloud-request'
import { connectorRetryDelayMs } from './connector-outbox'

// A deploy drains every host at once, and a crashed instance fails ~1,000 polls at once: their next
// requests spread over this.
export const CONNECTOR_RECONNECT_SPREAD_MS = 20_000

export function connectorReconnectSpreadMs(random: () => number): number {
  return random() * CONNECTOR_RECONNECT_SPREAD_MS
}

/** A failed poll's wait: the first spreads like a drain's re-poll, later ones double as usual. */
export function connectorPollRetryMs(
  failures: number,
  failure: ConnectorFailure,
  random: () => number
): number {
  return failures === 0
    ? Math.max(connectorReconnectSpreadMs(random), failure.retryAfterMs ?? 0)
    : connectorRetryDelayMs(failures, failure, random)
}

/** Waits out a poll answer's pause or reconnect spread; returns the cloud's stop reason, if it gave one. */
export async function obeyConnectorPollControl(
  raw: unknown,
  random: () => number,
  signal: AbortSignal
): Promise<string | null> {
  const control = ConnectorPollControl.safeParse(raw)
  if (!control.success) {
    return null
  }
  if ('stop' in control.data) {
    return control.data.stop
  }
  const waitMs =
    'pausedForMs' in control.data ? control.data.pausedForMs : connectorReconnectSpreadMs(random)
  await delayUnlessAborted(waitMs, signal)
  return null
}
