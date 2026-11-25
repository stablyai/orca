import { delayUnlessAborted } from '../../shared/concurrency/abort-aware-delay'
import { ConnectorPollControl } from '../../shared/connectors/connector-cloud-contract'
import type { ConnectorFailure } from './connector-cloud-request'
import type { ConnectorSnapshotReason } from './connector-snapshot-trace'
import { connectorRetryDelayMs } from './connector-outbox'

// A deploy drains every host at once, and a crashed instance fails ~1,000 polls at once: their next
// requests spread over this.
export const CONNECTOR_RECONNECT_SPREAD_MS = 20_000

export function connectorReconnectSpreadMs(random: () => number): number {
  return random() * CONNECTOR_RECONNECT_SPREAD_MS
}

// A deploy that changes the cloud's features answers hello_required to many hosts close together; each
// waits up to this long before its new hello and snapshot, so they don't all land at once.
export const CONNECTOR_REHELLO_SPREAD_MS = 60_000

export function connectorRehelloSpreadMs(random: () => number): number {
  return random() * CONNECTOR_REHELLO_SPREAD_MS
}

// How often a wait on a client's state checks it again.
const UNTIL_CHECK_MS = 250

/** Resolves once `done` holds after the hello in flight (`saying`) lands, or once `signal` aborts. */
export async function waitUntil(
  done: () => boolean,
  saying: () => Promise<unknown>,
  signal: AbortSignal
): Promise<void> {
  while (!signal.aborted) {
    await saying().catch(() => null)
    if (done()) {
      return
    }
    await delayUnlessAborted(UNTIL_CHECK_MS, signal)
  }
}

/** A 409's re-hello spread, which a change to say (`cut`) ends early so it reaches the cloud at once. */
export class ConnectorRehelloSpread {
  private cutting: AbortController | null = null

  async wait(random: () => number, signal: AbortSignal): Promise<null> {
    this.cutting = new AbortController()
    await delayUnlessAborted(
      connectorRehelloSpreadMs(random),
      AbortSignal.any([signal, this.cutting.signal])
    )
    this.cutting = null
    return null
  }

  cut(): void {
    this.cutting?.abort()
  }
}

/** Why a failed poll dropped its hello, for the snapshot it takes. */
export function connectorPollDropReason(failure: ConnectorFailure): ConnectorSnapshotReason {
  if (failure.status !== 409) {
    return 'poll-failed'
  }
  return failure.reason === 'features' ? 'poll-409-features' : 'poll-409'
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

/** Waits out a failed poll's wait, or until `signal` aborts. */
export async function waitPollRetry(
  failures: number,
  failure: ConnectorFailure,
  random: () => number,
  signal: AbortSignal
): Promise<null> {
  await delayUnlessAborted(connectorPollRetryMs(failures, failure, random), signal)
  return null
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
