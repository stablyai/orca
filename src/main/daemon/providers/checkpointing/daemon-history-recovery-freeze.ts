import type { HistoryRecoveryContext } from '../adapter/daemon-pty-runtime-state'
import type { HistoryRecoveryFreeze } from '../../history/storage/terminal-history-recovery-quarantine'

// Taking and clearing together prevents any recovery branch from retaining a consumed freeze.
export function takeHistoryRecoveryFreeze(
  historyRecovery: HistoryRecoveryContext,
  sessionId: string
): HistoryRecoveryFreeze | undefined {
  const freeze =
    historyRecovery.freeze?.sessionId === sessionId ? historyRecovery.freeze : undefined
  historyRecovery.freeze = null
  return freeze
}
