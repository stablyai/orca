import { mergeDictationTerms, type DictationTerm } from '../../../shared/dictation-dictionary'
import { getRepoIdFromWorktreeId } from '../../../shared/worktree/id'
import type { RuntimeStore } from '../construction/runtime-store-contract'

/** This host's dictionary for a worktree: its repo's terms, then the personal ones. A folder workspace has no repo row, so it gets the personal ones. */
export function hostDictationTerms(
  store: RuntimeStore,
  worktreeId: string | undefined
): DictationTerm[] {
  const repo = worktreeId ? store.getRepo(getRepoIdFromWorktreeId(worktreeId)) : undefined
  return mergeDictationTerms(repo?.dictationTerms, store.getSettings().voice?.dictationTerms)
}
