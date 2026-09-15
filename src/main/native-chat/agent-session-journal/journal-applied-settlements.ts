import type { JournalReducerState } from './journal-reducer'

export const MAX_JOURNAL_APPLIED_SETTLEMENT_IDS = 4_096

export function rememberAppliedSettlementId(
  state: JournalReducerState,
  settlementId: string
): void {
  state.appliedSettlementIds.add(settlementId)
  while (state.appliedSettlementIds.size > MAX_JOURNAL_APPLIED_SETTLEMENT_IDS) {
    const oldest = state.appliedSettlementIds.values().next().value
    if (oldest === undefined) {
      return
    }
    state.appliedSettlementIds.delete(oldest)
  }
}
