import type { Store } from '../persistence/loading-store/store'
import type { CodexManagedAccount } from '../../shared/managed-account-types'
import { getRepoIdFromWorktreeId } from '../../shared/worktree/id'

/** The saved Codex account a worktree's project pins; a removed one pins nothing. */
export function projectPinnedCodexAccount(
  store: Pick<Store, 'getSettings'> & Partial<Pick<Store, 'getRepo'>>,
  worktreeId: string | undefined,
  projectAccountId?: string
): CodexManagedAccount | null {
  const accountId =
    projectAccountId ??
    (worktreeId ? store.getRepo?.(getRepoIdFromWorktreeId(worktreeId))?.codexAccountId : undefined)
  return accountId
    ? (store.getSettings().codexManagedAccounts.find((saved) => saved.id === accountId) ?? null)
    : null
}
