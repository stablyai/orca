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
  private readonly listeners = new Set<(stage: RelayDialStage) => void>()

  getDialStage(): RelayDialStage {
    return this.stage
  }

  onDialStageChange(listener: (stage: RelayDialStage) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  advance(stage: RelayDialStage): void {
    if (this.stage === stage) {
      return
    }
    this.stage = stage
    for (const listener of this.listeners) {
      listener(stage)
    }
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
