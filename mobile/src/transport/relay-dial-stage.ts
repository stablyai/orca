import { elapsedMs, monotonicNowMs } from './monotonic-clock'

// Where a relay dial is waiting, so a bound can tell "the cell never answered the
// upgrade" from "the cell took the dial and is slow" — the two look identical from
// ConnectionState, which stays 'connecting' until relay-hello arrives.
export type RelayDialStage =
  // WebSocket upgrade not yet open.
  | 'opening'
  // Socket open and relay-auth sent; the cell is resolving/reserving and asking the
  // desktop to attach before it can answer with relay-hello.
  | 'awaiting-hello'
  // relay-hello accepted; E2EE handshake with the desktop in flight.
  | 'handshaking'
  // E2EE authenticated; waiting on the desktop's resume confirmation.
  | 'confirming'

// Exhaustive by construction: adding a stage to the union breaks this table, so a
// persisted-log validator can never silently start accepting an unknown stage.
export const RELAY_DIAL_STAGE_NAMES: Record<RelayDialStage, true> = {
  opening: true,
  'awaiting-hello': true,
  handshaking: true,
  confirming: true
}

// How long a dial spent in one stage. `complete` is false when the dial left the
// stage by dying in it, so a report can name the stage that never finished.
export type RelayDialStageTiming = {
  stage: RelayDialStage
  ms: number
  complete: boolean
}

export type RelayDialStageSource = {
  getDialStage(): RelayDialStage
  onDialStageChange(listener: (stage: RelayDialStage) => void): () => void
}

export function relayDialStageSource(session: object): RelayDialStageSource | null {
  const candidate = session as Partial<RelayDialStageSource>
  return typeof candidate.getDialStage === 'function' &&
    typeof candidate.onDialStageChange === 'function'
    ? (candidate as RelayDialStageSource)
    : null
}

export class RelayDialStageTracker implements RelayDialStageSource {
  private stage: RelayDialStage = 'opening'
  private stageEnteredAt: number
  private settled = false
  private readonly listeners = new Set<(stage: RelayDialStage) => void>()

  constructor(private readonly now: () => number = monotonicNowMs) {
    this.stageEnteredAt = now()
  }

  getDialStage(): RelayDialStage {
    return this.stage
  }

  onDialStageChange(listener: (stage: RelayDialStage) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Returns the timing of the stage just left, or null when nothing was timed. */
  advance(stage: RelayDialStage): RelayDialStageTiming | null {
    if (this.stage === stage) {
      return null
    }
    const now = this.now()
    const timing = this.settled ? null : this.closeStage(true, now)
    this.stage = stage
    this.stageEnteredAt = now
    for (const listener of this.listeners) {
      listener(stage)
    }
    return timing
  }

  // Close the stage the dial is sitting in: `true` once it reached the runtime,
  // `false` when it died there. Idempotent, so a failure on an already-connected
  // session cannot re-time the last dial stage.
  settle(complete: boolean): RelayDialStageTiming | null {
    if (this.settled) {
      return null
    }
    this.settled = true
    return this.closeStage(complete, this.now())
  }

  private closeStage(complete: boolean, now: number): RelayDialStageTiming {
    return { stage: this.stage, ms: elapsedMs(this.stageEnteredAt, now), complete }
  }
}

// Budget per stage once the cell holds the dial. awaiting-hello covers the cell's
// assignment/reservation transactions (observed 14–16s under lock contention) plus its
// 10s host-attach deadline; handshaking is two E2EE round trips; confirming is bounded
// by the session's own 30s resume-confirmation request, with slack so that error wins.
const RELAY_DIAL_STAGE_BUDGET_MS: Record<Exclude<RelayDialStage, 'opening'>, number> = {
  'awaiting-hello': 30_000,
  handshaking: 12_000,
  confirming: 35_000
}

export function relayDialStageBudgetMs(stage: Exclude<RelayDialStage, 'opening'>): number {
  return RELAY_DIAL_STAGE_BUDGET_MS[stage]
}
