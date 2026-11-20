import type { Store } from '../persistence/loading-store/store'
import { startCodexHistoryCleanupPolicyLiveUpdates } from '../codex/history/cleanup-policy/codex-history-cleanup-policy-live-update'
import { startJournalRetirementPolicyLiveUpdates } from '../native-chat/journal-retirement-policy/journal-retirement-policy-live-update'

/** The remote policies that stage deleting local files: Codex history and the old chat journal. */
export function startCleanupPolicyLiveUpdates(store: Store, serve: boolean): void {
  startCodexHistoryCleanupPolicyLiveUpdates(store)
  // Only the desktop app may remove the old chat journal, so headless serve never needs its policy.
  if (!serve) {
    startJournalRetirementPolicyLiveUpdates(store)
  }
}
