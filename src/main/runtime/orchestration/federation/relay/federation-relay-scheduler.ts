const RELAY_BASE_DELAY_MS = 1_000
// 30 s keeps an offline host to two failed syncs a minute, and a recovered one at most 30 s behind.
const RELAY_MAX_DELAY_MS = 30_000
/** How often a coordinator blocked in `check --wait` re-arms its run's relays, so recovery is seen within this. */
export const FEDERATION_RELAY_WAIT_REARM_MS = 15_000
// A relay something just asked for keeps the base cadence this long; a waiting coordinator re-arms before it lapses.
const RELAY_AWAKE_MS = 2 * FEDERATION_RELAY_WAIT_REARM_MS

/** 'moved': the sync imported or sent mail; 'idle': it found nothing to move. */
export type FederationRelayTickOutcome = 'moved' | 'idle' | 'failed' | 'ended'

/** Consecutive failures double the wait up to the cap; a failure never ends a relay, since an unreachable host or dispatch can come back. */
export function federationRelayRetryDelayMs(failures: number): number {
  return failures === 0
    ? RELAY_BASE_DELAY_MS
    : Math.min(RELAY_MAX_DELAY_MS, RELAY_BASE_DELAY_MS * 2 ** failures)
}

type RelayChain = {
  environmentId: string
  failures: number
  idleSyncs: number
  awakeUntil: number
  timer: ReturnType<typeof setTimeout> | null
  dueAt: number
  running: boolean
  runAgain: boolean
}

/** One self-rescheduling sync per dispatch. Failing and idle relays back off to the cap, so a dead, unreachable or quiet
 *  dispatch is not polled every second; a relay something asked for keeps the base cadence for RELAY_AWAKE_MS. */
export class FederationRelayScheduler {
  private readonly chains = new Map<string, RelayChain>()
  private readonly dispatchesByEnvironment = new Map<string, Set<string>>()

  constructor(private readonly tick: (dispatchId: string) => Promise<FederationRelayTickOutcome>) {}

  /** Starts a relay, or asks an existing one to sync now without forgetting its failures. */
  arm(dispatchId: string, environmentId: string): void {
    const chain = this.chains.get(dispatchId)
    if (chain) {
      wake(chain)
      this.syncSoon(dispatchId, chain)
      return
    }
    const created: RelayChain = {
      environmentId,
      failures: 0,
      idleSyncs: 0,
      awakeUntil: Date.now() + RELAY_AWAKE_MS,
      timer: null,
      dueAt: 0,
      running: false,
      runAgain: false
    }
    this.chains.set(dispatchId, created)
    const siblings = this.dispatchesByEnvironment.get(environmentId) ?? new Set<string>()
    siblings.add(dispatchId)
    this.dispatchesByEnvironment.set(environmentId, siblings)
    void this.run(dispatchId, created)
  }

  /** Keeps a relay at the base cadence while a coordinator waits, without cutting short a failure backoff. */
  keepAwake(dispatchId: string, environmentId: string): void {
    const chain = this.chains.get(dispatchId)
    if (!chain) {
      this.arm(dispatchId, environmentId)
      return
    }
    wake(chain)
    this.pullForwardToBase(dispatchId, chain)
  }

  /** A server that just verified is worth retrying, and watching, at the base cadence. */
  resetEnvironment(environmentId: string): void {
    for (const dispatchId of this.dispatchesByEnvironment.get(environmentId) ?? []) {
      const chain = this.chains.get(dispatchId)
      if (chain) {
        chain.failures = 0
        wake(chain)
        this.syncSoon(dispatchId, chain)
      }
    }
  }

  /** A sync another caller completed proves the relay healthy again, and one that moved mail wakes it, so the next sync returns to the base cadence. */
  noteSynced(dispatchId: string, moved: boolean): void {
    const chain = this.chains.get(dispatchId)
    if (!chain || chain.running || (chain.failures === 0 && !moved)) {
      return
    }
    if (moved) {
      wake(chain)
    }
    chain.failures = 0
    this.pullForwardToBase(dispatchId, chain)
  }

  clear(): void {
    for (const chain of this.chains.values()) {
      if (chain.timer) {
        clearTimeout(chain.timer)
      }
    }
    this.chains.clear()
    this.dispatchesByEnvironment.clear()
  }

  private pullForwardToBase(dispatchId: string, chain: RelayChain): void {
    if (chain.running || chain.failures > 0) {
      return
    }
    const baseDelayMs = federationRelayRetryDelayMs(0)
    // Only pull the next sync earlier; an already-requested immediate sync must not be postponed.
    if (!chain.timer || chain.dueAt > Date.now() + baseDelayMs) {
      this.schedule(dispatchId, chain, baseDelayMs)
    }
  }

  private syncSoon(dispatchId: string, chain: RelayChain): void {
    if (chain.running) {
      chain.runAgain = true
      return
    }
    this.schedule(dispatchId, chain, 0)
  }

  private schedule(dispatchId: string, chain: RelayChain, delayMs: number): void {
    if (chain.timer) {
      clearTimeout(chain.timer)
    }
    chain.dueAt = Date.now() + delayMs
    chain.timer = setTimeout(() => void this.run(dispatchId, chain), delayMs)
    chain.timer.unref?.()
  }

  private async run(dispatchId: string, chain: RelayChain): Promise<void> {
    if (this.chains.get(dispatchId) !== chain) {
      return
    }
    chain.timer = null
    chain.running = true
    const outcome = await this.tick(dispatchId).catch((): FederationRelayTickOutcome => 'failed')
    chain.running = false
    // A cleared or replaced chain must not come back from a sync that outlived it.
    if (this.chains.get(dispatchId) !== chain) {
      return
    }
    if (outcome === 'ended') {
      this.chains.delete(dispatchId)
      const siblings = this.dispatchesByEnvironment.get(chain.environmentId)
      siblings?.delete(dispatchId)
      if (siblings?.size === 0) {
        this.dispatchesByEnvironment.delete(chain.environmentId)
      }
      return
    }
    if (outcome === 'failed') {
      chain.failures += 1
      chain.idleSyncs = 0
    } else {
      chain.failures = 0
      chain.idleSyncs =
        outcome === 'moved' || Date.now() < chain.awakeUntil ? 0 : chain.idleSyncs + 1
    }
    const delayMs = chain.runAgain
      ? 0
      : federationRelayRetryDelayMs(chain.failures > 0 ? chain.failures : chain.idleSyncs)
    chain.runAgain = false
    this.schedule(dispatchId, chain, delayMs)
  }
}

function wake(chain: RelayChain): void {
  chain.awakeUntil = Date.now() + RELAY_AWAKE_MS
  chain.idleSyncs = 0
}
