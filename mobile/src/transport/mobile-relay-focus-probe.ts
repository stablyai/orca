import {
  isLogicalClientCutoverError,
  type StableLogicalRpcClient
} from './stable-logical-rpc-client'

// Why: a probe must fail well before the 12s connect ceiling so a dead socket
// still recovers in a few seconds, but outlast one slow cellular RTT.
const PROBE_TIMEOUT_MS = 4_000
// Why: focus fires per navigation event; one liveness answer covers them all.
const PROBE_MIN_INTERVAL_MS = 10_000

// Cheap liveness check for a focus nudge on an active relay: a healthy session
// answers and nothing visible changes; only a dead one is handed to onDead.
export class MobileRelayFocusProbe {
  private lastProbeAt = 0

  constructor(
    private readonly args: {
      logical: StableLogicalRpcClient
      now: () => number
      canProbe: () => boolean
      onDead: (detail: string) => void
    }
  ) {}

  async probe(): Promise<void> {
    const { logical, now } = this.args
    const at = now()
    if (
      !this.args.canProbe() ||
      at - this.lastProbeAt < PROBE_MIN_INTERVAL_MS ||
      logical.getActivePath() !== 'relay' ||
      logical.getState() !== 'connected'
    ) {
      return
    }
    this.lastProbeAt = at
    const generation = logical.getGeneration()
    try {
      await logical.sendRequest('status.get', null, { timeoutMs: PROBE_TIMEOUT_MS })
    } catch (error) {
      if (
        isLogicalClientCutoverError(error) ||
        !this.args.canProbe() ||
        logical.getGeneration() !== generation ||
        logical.getActivePath() !== 'relay'
      ) {
        return
      }
      this.args.onDead(String((error as Error).message).slice(0, 80))
    }
  }
}
