const RELAY_BASE_DELAY_MS = 1_000
const RELAY_MAX_DELAY_MS = 60_000

export type FederationRelayTickOutcome = 'synced' | 'failed' | 'ended'

/** Consecutive failures double the wait up to a minute; no failure ends a relay, since a missing host or dispatch can come back. */
export function federationRelayRetryDelayMs(failures: number): number {
  return failures === 0
    ? RELAY_BASE_DELAY_MS
    : Math.min(RELAY_MAX_DELAY_MS, RELAY_BASE_DELAY_MS * 2 ** failures)
}

type RelayChain = {
  environmentId: string
  failures: number
  timer: ReturnType<typeof setTimeout> | null
  running: boolean
  runAgain: boolean
}

/** One self-rescheduling sync per dispatch, so a dead or unreachable dispatch backs off instead of polling every second. */
export class FederationRelayScheduler {
  private readonly chains = new Map<string, RelayChain>()

  constructor(private readonly tick: (dispatchId: string) => Promise<FederationRelayTickOutcome>) {}

  /** Starts a relay, or asks an existing one to sync now without forgetting its failures. */
  arm(dispatchId: string, environmentId: string): void {
    const chain = this.chains.get(dispatchId)
    if (chain) {
      this.syncSoon(dispatchId, chain)
      return
    }
    const created: RelayChain = {
      environmentId,
      failures: 0,
      timer: null,
      running: false,
      runAgain: false
    }
    this.chains.set(dispatchId, created)
    void this.run(dispatchId, created)
  }

  /** A server that just verified is worth retrying at the base cadence. */
  resetEnvironment(environmentId: string): void {
    for (const [dispatchId, chain] of this.chains) {
      if (chain.environmentId === environmentId) {
        chain.failures = 0
        this.syncSoon(dispatchId, chain)
      }
    }
  }

  clear(): void {
    for (const chain of this.chains.values()) {
      if (chain.timer) {
        clearTimeout(chain.timer)
      }
    }
    this.chains.clear()
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
      return
    }
    chain.failures = outcome === 'synced' ? 0 : chain.failures + 1
    const delayMs = chain.runAgain ? 0 : federationRelayRetryDelayMs(chain.failures)
    chain.runAgain = false
    this.schedule(dispatchId, chain, delayMs)
  }
}
