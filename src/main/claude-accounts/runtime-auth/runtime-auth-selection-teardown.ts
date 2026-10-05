import type { Store } from '../../persistence'
import {
  normalizeClaudeRuntimeSelection,
  setSelectedClaudeAccountIdForTarget,
  type ClaudeAccountSelectionTarget
} from '../runtime-selection'
import type { ClaudeManagedOauthRead } from './runtime-auth-managed-credentials'

/**
 * Drop the account selected for `target`, keeping the legacy host field in step.
 * Three call sites in the sync did this identically.
 */
export function clearClaudeSelectionForTarget(
  store: Store,
  settings: ReturnType<Store['getSettings']>,
  target: ClaudeAccountSelectionTarget
): void {
  store.updateSettings({
    activeClaudeManagedAccountId:
      target.runtime === 'host' ? null : settings.activeClaudeManagedAccountId,
    activeClaudeManagedAccountIdsByRuntime: setSelectedClaudeAccountIdForTarget(
      normalizeClaudeRuntimeSelection(settings),
      null,
      target
    )
  })
}

/**
 * The outgoing account's oauth identity is the only evidence that the runtime is
 * still holding THIS account's credentials, and it is the sole decider on the
 * first sync after a restart: the service seeds `lastSyncedAccountId` from
 * settings without materializing, so the account is unchanged and
 * `hasMaterializedRuntimeAuth` is false.
 *
 * If it could not be read we can neither prove a restore is needed nor safely
 * run one -- the restore consumes the same value for its own ownership checks --
 * so the caller must leave the whole transition for the next sync rather than
 * clear the selection without putting the user's default back.
 */
export function shouldDeferOnUnreadableOauth(read: ClaudeManagedOauthRead | null): boolean {
  if (read?.kind !== 'indeterminate') {
    return false
  }
  console.warn(
    '[claude-runtime-auth] Could not read the outgoing account oauth identity; leaving the selection in place',
    read.error
  )
  return true
}
