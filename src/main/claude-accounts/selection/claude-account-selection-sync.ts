import type { ClaudeAccountRuntime, ClaudeAccountSettings } from './claude-account-selection'
import type { ClaudeAccountSelectionTarget } from './runtime-selection'

type ClaudeSelectionPointer = Pick<
  ClaudeAccountSettings,
  'activeClaudeManagedAccountId' | 'activeClaudeManagedAccountIdsByRuntime'
>

/** What a selection change left: `moved` (it reached new launches), `unchanged`, or `unknown` (it
 *  failed and the earlier selection could not be restored and republished either). */
export type ClaudeSelectionOutcome = 'moved' | 'unchanged' | 'unknown'

/** Saves and publishes `next` as one step: if either fails, restores `previous` and its publication,
 *  then rethrows, so no selection stands that new launches do not follow. Before the original error
 *  is rethrown, `restoreSettled` hears `moved` once the restore is republished, or `unknown` when the
 *  restore fails too. */
async function applyClaudeSelectionOrRestore(
  runtimeAuth: Pick<ClaudeAccountRuntime, 'syncForCurrentSelection' | 'publishAll'>,
  saveSettings: (patch: Partial<ClaudeAccountSettings>) => void,
  change: { previous: ClaudeSelectionPointer; next: ClaudeSelectionPointer },
  target: ClaudeAccountSelectionTarget | undefined,
  restoreSettled: (outcome: Exclude<ClaudeSelectionOutcome, 'unchanged'>) => void
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
      restoreSettled('unknown')
      throw error
    }
    restoreSettled('moved')
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
  restoreSettled: (outcome: Exclude<ClaudeSelectionOutcome, 'unchanged'>) => void
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
      restoreSettled
    )
}
