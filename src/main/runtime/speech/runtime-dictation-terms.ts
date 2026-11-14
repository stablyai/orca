import { dictationTermsFor, type DictationTerm } from '../../../shared/dictation-dictionary'
import { getRepoIdFromWorktreeId } from '../../../shared/worktree/id'
import type { RuntimeStore } from '../construction/runtime-store-contract'

/** This host's dictionary for a worktree; a folder workspace has no repo row, so it gets the personal terms. */
export function hostDictationTerms(
  store: RuntimeStore,
  worktreeId: string | undefined
): DictationTerm[] {
  const repo = worktreeId ? store.getRepo(getRepoIdFromWorktreeId(worktreeId)) : undefined
  return dictationTermsFor(store.getSettings().voice, repo)
}
