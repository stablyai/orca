export const DEFAULT_CLIENT_HOSTED_RECONCILIATION_WINDOW_MS = 45_000

/** A client with no paired-device identity, which no host attach can ever speak for. */
const ANONYMOUS_CLIENT = '\0anonymous'
const READ_REPLY = Symbol('read-reply')
type Observation = object | symbol

/** Restart snapshots precede host inventories; hold browser-row culling until each client's host reconciles.
 * One client's attach proves nothing about another; bound never-attached clients by the deadline. */
export class ClientHostedPageReconciliationWindow {
  private readonly reconciledClients = new Set<string>()
  private readonly observations = new Map<string, Map<Observation, Set<string>>>()

  constructor(
    private readonly openedAt: number,
    private readonly windowMs: number = DEFAULT_CLIENT_HOSTED_RECONCILIATION_WINDOW_MS
  ) {}

  markReconciled(pairedDeviceId: string): ReadonlySet<string> | undefined {
    const key = clientKey(pairedDeviceId)
    this.reconciledClients.add(key)
    const observations = this.observations.get(key)
    this.observations.delete(key)
    return observations && new Set([...observations.values()].flatMap((held) => [...held]))
  }

  forgetClient(pairedDeviceId: string): void {
    this.observations.delete(clientKey(pairedDeviceId))
  }

  observe(
    frames: readonly { worktree: string; clientHostedPagesUnreconciled?: true; removed?: true }[],
    pairedDeviceId?: string,
    observer: Observation = READ_REPLY
  ): void {
    const key = clientKey(pairedDeviceId)
    const observations = this.observations.get(key) ?? new Map<Observation, Set<string>>()
    const held = observations.get(observer) ?? new Set<string>()
    for (const frame of frames) {
      if (frame.clientHostedPagesUnreconciled && !frame.removed) {
        held.add(frame.worktree)
      } else {
        held.delete(frame.worktree)
      }
    }
    if (held.size) {
      observations.set(observer, held)
    } else {
      observations.delete(observer)
    }
    if (observations.size) {
      this.observations.set(key, observations)
    } else {
      this.observations.delete(key)
    }
  }

  forgetObservation(pairedDeviceId: string | undefined, observer: Observation): void {
    const key = clientKey(pairedDeviceId)
    const observations = this.observations.get(key)
    observations?.delete(observer)
    if (observations?.size === 0) {
      this.observations.delete(key)
    }
  }

  forgetWorktree(worktree: string): void {
    for (const [key, observations] of this.observations) {
      for (const [observer, held] of observations) {
        held.delete(worktree)
        if (!held.size) {
          observations.delete(observer)
        }
      }
      if (!observations.size) {
        this.observations.delete(key)
      }
    }
  }

  dispose(): void {
    this.observations.clear()
    this.reconciledClients.clear()
  }

  isUnreconciled(pairedDeviceId: string | undefined, now: number): boolean {
    return (
      !this.reconciledClients.has(clientKey(pairedDeviceId)) && now - this.openedAt < this.windowMs
    )
  }

  /** Set and clear per recipient: shared fan-out frames must not inherit another client's hold. */
  holdFor<T extends { worktree: string; clientHostedPagesUnreconciled?: true }>(
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
