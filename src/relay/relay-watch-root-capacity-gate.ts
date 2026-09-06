import {
  assertRelayWatcherRootCapacity,
  exceedsRelayWatcherRootCapacity
} from './relay-watcher-root-capacity'

type RelayWatchRootTeardowns = {
  rootPaths: () => string[]
  /** Resolves when every teardown in flight has settled, or undefined when none is. */
  settlePending: () => Promise<void> | undefined
}

/**
 * Decides whether a prospective watch root fits, and waits out an over-cap that only unsubscribing
 * roots are causing.
 *
 * Why waiting beats refusing: a reconnect tears the old roots down as it installs the new ones, so
 * the cap is briefly full of slots already promised back. The client answers a capacity refusal
 * with a 60s-to-30min dormancy that no release event can shorten, so refusing on a transient
 * overlap costs half an hour of blindness. Mirrors WatcherSupervisorCapacityWait.
 */
export class RelayWatchRootCapacityGate {
  // Why tracked: a root parked on the wait has been granted nothing, so counting its setup entry
  // would let it hold a slot away from the root already reclaiming one.
  private readonly waiting = new Set<string>()

  constructor(
    private readonly activeRoots: ReadonlyMap<string, unknown>,
    private readonly setupRoots: ReadonlyMap<string, unknown>,
    // Thunk: the registry builds its teardown tracker after this field initializes.
    private readonly teardowns: () => RelayWatchRootTeardowns
  ) {}

  assert(rootKey: string): void {
    assertRelayWatcherRootCapacity(
      this.activeRoots.keys(),
      this.claimedSetupRoots(rootKey),
      this.teardowns().rootPaths(),
      rootKey
    )
  }

  /**
   * The wait to hold before {@link assert}, or undefined when there is nothing to wait for.
   *
   * Undefined rather than a resolved promise so an install that already fits stays synchronous —
   * a suspension here would let a concurrent watch of the same root join the setup, not the watch.
   */
  release(rootKey: string, signal?: AbortSignal): Promise<void> | undefined {
    if (
      !exceedsRelayWatcherRootCapacity(
        this.activeRoots.keys(),
        this.claimedSetupRoots(rootKey),
        this.teardowns().rootPaths(),
        rootKey
      )
    ) {
      return undefined
    }
    const released = this.teardowns().settlePending()
    if (!released) {
      return undefined
    }
    this.waiting.add(rootKey)
    // Once, and never past the caller: a genuinely full cap must still reach the refusal that sends
    // the client dormant, and an unsubscribe that never settles must not park the request with it.
    return (signal ? Promise.race([released, abortSignalSettled(signal)]) : released).finally(
      () => {
        this.waiting.delete(rootKey)
      }
    )
  }

  /** Setup roots that currently hold a slot — a parked capacity waiter holds none. */
  private claimedSetupRoots(rootKey: string): string[] {
    return [...this.setupRoots.keys()].filter((key) => key === rootKey || !this.waiting.has(key))
  }
}

/** Resolves (never rejects) when the request is abandoned, so a race can drop out of a wait. */
function abortSignalSettled(signal: AbortSignal): Promise<void> {
  return signal.aborted
    ? Promise.resolve()
    : new Promise<void>((resolve) =>
        signal.addEventListener('abort', () => resolve(), { once: true })
      )
}
