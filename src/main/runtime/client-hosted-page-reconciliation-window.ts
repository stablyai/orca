export const DEFAULT_CLIENT_HOSTED_RECONCILIATION_WINDOW_MS = 45_000

/** A client with no paired-device identity, which no host attach can ever speak for. */
const ANONYMOUS_CLIENT = '\0anonymous'

/**
 * Tracks, per paired client, whether this runtime has yet heard from the host holding that client's
 * client-hosted pages.
 *
 * A restarted runtime rehydrates terminals from disk and starts publishing session-tab snapshots
 * immediately, but it cannot know about client-hosted browser pages until a host attaches and
 * reports them. Those first snapshots therefore look authoritative while being silently empty of
 * browser rows, and a client that trusts them culls its own live tabs.
 *
 * Per client and not per process: with two paired clients the first attach says nothing about the
 * second's pages, and a shared latch would open the cull window for a client whose host has not
 * spoken yet. A client that never attaches is bounded by the deadline instead -- an unbounded hold
 * would leave rows for pages nothing is hosting, which is the failure this exists to avoid.
 */
export class ClientHostedPageReconciliationWindow {
  private readonly reconciledClients = new Set<string>()

  constructor(
    private readonly openedAt: number,
    private readonly windowMs: number = DEFAULT_CLIENT_HOSTED_RECONCILIATION_WINDOW_MS
  ) {}

  markReconciled(pairedDeviceId: string): void {
    this.reconciledClients.add(clientKey(pairedDeviceId))
  }

  isUnreconciled(pairedDeviceId: string | undefined, now: number): boolean {
    return (
      !this.reconciledClients.has(clientKey(pairedDeviceId)) && now - this.openedAt < this.windowMs
    )
  }

  /**
   * Answers this client's hold on a snapshot bound for it.
   *
   * Sets *and* clears, because a frame is built once and sent to every subscriber: carrying one
   * client's hold onto another client's copy would hold rows the second client already reconciled.
   */
  holdFor<T extends { clientHostedPagesUnreconciled?: true }>(
    result: T,
    pairedDeviceId: string | undefined,
    now: number
  ): T {
    const hold = this.isUnreconciled(pairedDeviceId, now)
    if (hold === (result.clientHostedPagesUnreconciled === true)) {
      return result
    }
    if (hold) {
      return { ...result, clientHostedPagesUnreconciled: true as const }
    }
    const { clientHostedPagesUnreconciled: _held, ...released } = result
    return released as T
  }
}

function clientKey(pairedDeviceId: string | undefined): string {
  return pairedDeviceId && pairedDeviceId.length > 0 ? pairedDeviceId : ANONYMOUS_CLIENT
}
