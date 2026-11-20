import type { ClaudeAccountRuntime, ClaudeAccountSettings } from './claude-account-selection'
import type { ClaudeAccountSelectionTarget } from './runtime-selection'

export type ClaudeSelectionPointer = Pick<
  ClaudeAccountSettings,
  'activeClaudeManagedAccountId' | 'activeClaudeManagedAccountIdsByRuntime'
>

/** What a selection change left: `moved` (it reached new launches), `unchanged`, or `unknown` (it
 *  failed and the earlier selection could not be restored and republished either). */
export type ClaudeSelectionOutcome = 'moved' | 'unchanged' | 'unknown'

/** Saves and publishes `next` as one step: if either fails, restores `previous` and its publication,
 *  then rethrows, so no selection stands that new launches do not follow. A restore that fails too
 *  calls `routeUnknown` before the original error is rethrown. */
export async function applyClaudeSelectionOrRestore(
  runtimeAuth: Pick<ClaudeAccountRuntime, 'syncForCurrentSelection' | 'publishAll'>,
  saveSettings: (patch: Partial<ClaudeAccountSettings>) => void,
  change: { previous: ClaudeSelectionPointer; next: ClaudeSelectionPointer },
  target: ClaudeAccountSelectionTarget | undefined,
  routeUnknown: () => void
): Promise<void> {
  try {
    saveSettings(pointer(change.next))
    await runtimeAuth.syncForCurrentSelection(target)
  } catch (error) {
    try {
      saveSettings(pointer(change.previous))
      await runtimeAuth.publishAll()
    } catch (restoreError) {
      console.warn('[claude-accounts] Could not restore the Claude selection:', restoreError)
      routeUnknown()
    }
    throw error
  }
}

function pointer(selection: ClaudeSelectionPointer): ClaudeSelectionPointer {
  return {
    activeClaudeManagedAccountId: selection.activeClaudeManagedAccountId,
    activeClaudeManagedAccountIdsByRuntime: selection.activeClaudeManagedAccountIdsByRuntime
  }
}

/** `applyClaudeSelectionOrRestore` bound to one selection's runtime, settings and failure report. */
export function claudeSelectionApplier(
  runtimeAuth: () => Pick<ClaudeAccountRuntime, 'syncForCurrentSelection' | 'publishAll'>,
  saveSettings: (patch: Partial<ClaudeAccountSettings>) => void,
  routeUnknown: () => void
) {
  return (
    previous: ClaudeSelectionPointer,
    target: ClaudeAccountSelectionTarget | undefined,
    next: ClaudeSelectionPointer
  ): Promise<void> =>
    applyClaudeSelectionOrRestore(
      runtimeAuth(),
      saveSettings,
      { previous, next },
      target,
      routeUnknown
    )
}
