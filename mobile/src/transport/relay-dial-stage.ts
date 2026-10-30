import type { RpcClient } from './rpc-client'

// Separate cell assignment from upgrade because ConnectionState remains connecting through both.
export type RelayDialStage =
  | 'opening'
  // The cell resolves/reserves and waits for desktop attach after relay-auth.
  | 'awaiting-hello'
  | 'handshaking'
  | 'confirming'

export type RelayDialStageSource = {
  getDialStage(): RelayDialStage
  onDialStageChange(listener: (stage: RelayDialStage) => void): () => void
}

export type MaybeRelayDialStageSource = RpcClient & Partial<RelayDialStageSource>

function reportsDialStages(
  session: MaybeRelayDialStageSource
): session is MaybeRelayDialStageSource & RelayDialStageSource {
  return (
    typeof session.getDialStage === 'function' && typeof session.onDialStageChange === 'function'
  )
}

export function relayDialStageSource(
  session: MaybeRelayDialStageSource
): RelayDialStageSource | null {
  return reportsDialStages(session) ? session : null
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

// Budget cell assignment plus attach, then E2EE round trips; leave confirmation slack so its own request deadline wins.
const RELAY_DIAL_STAGE_BUDGET_MS: Record<Exclude<RelayDialStage, 'opening'>, number> = {
  'awaiting-hello': 30_000,
  handshaking: 12_000,
  confirming: 35_000
}

export function relayDialStageBudgetMs(stage: Exclude<RelayDialStage, 'opening'>): number {
  return RELAY_DIAL_STAGE_BUDGET_MS[stage]
}
