export const DEFAULT_CLIENT_HOSTED_RECONCILIATION_WINDOW_MS = 45_000

/** A client with no paired-device identity, which no host attach can ever speak for. */
const ANONYMOUS_CLIENT = '\0anonymous'

/** Restart snapshots precede host inventories; hold browser-row culling until each client's host reconciles.
 * One client's attach proves nothing about another; bound never-attached clients by the deadline. */
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

  /** Set and clear per recipient: shared fan-out frames must not inherit another client's hold. */
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
