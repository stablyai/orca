import { getRealHomeConfigTomlPath, getRealHomeHooksJsonPath } from './codex-real-home-hooks-json'
import { readCodexTrustGrantLedgerHomeForReconciliation } from './codex-managed-trust-reconciliation'
import { removeSystemManagedHookTrustEntries } from './codex-hook-trust-cleanup'
import { getSystemCodexHomePath } from './codex-home-paths'
import { sweepRealHomeCodexHook } from './codex-real-home-hook-sweep'
import { runExclusivelyForCodexTrustConfig } from './codex-trust-config-mutation-queue'

/**
 * Strips every Orca entry, with its trust, from the user's real ~/.codex.
 * Orca's hook now travels as a session flag, so no current build needs one
 * there: app start runs this while hooks are on, and the opt-out always does.
 * It writes only when an entry is present, moving the user's own hooks'
 * approvals with their positions. An older Orca on the same HOME may add its
 * entry back on its own launches; the next start removes it again. Never throws.
 */
export async function removeRealHomeCodexHookEntries(): Promise<'removed' | 'unavailable'> {
  try {
    return await runExclusivelyForCodexTrustConfig(getRealHomeConfigTomlPath(), async () => {
      const lane = await sweepRealHomeCodexHook()
      const systemHomePath = getSystemCodexHomePath()
      // Why 'removed' only: an unread or malformed file may still hold the entry,
      // so its trust and the ledger that proves ownership must wait for a later pass.
      if (
        lane === 'removed' &&
        readCodexTrustGrantLedgerHomeForReconciliation(systemHomePath) !== null
      ) {
        // Why: the ledger outlives a sweep that removed the entry but not its trust.
        removeSystemManagedHookTrustEntries(systemHomePath, getRealHomeHooksJsonPath())
      }
      return lane
    })
  } catch (error) {
    console.warn('[codex-real-home-hooks] could not remove Orca entries from ~/.codex:', error)
    return 'unavailable'
  }
}
