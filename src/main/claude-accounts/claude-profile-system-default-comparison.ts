// How a host Claude account compares with System default: whether
// an old terminal's `claude` (which runs System default) runs another account than the selected one.
import type { ClaudeManagedAccount } from '../../shared/managed-account-types'
import type { ClaudeFolderLogin } from './claude-account-folder'
import { isSameClaudeLogin } from './claude-account-folder'

/** The router's public reads these comparisons use. */
export type SystemDefaultReads = {
  coveredBySystemDefault: (accountId: string) => boolean
  accountHome: (accountId: string) => string
  systemDefaultHome: () => string
  accountLogin: (accountId: string) => ClaudeFolderLogin | null
  systemDefaultLogin: (maxAgeMs?: number) => ClaudeFolderLogin | null
}

/** True unless the selected account's login and System default's are known and the same. */
export function systemDefaultRunsAnotherAccount(
  reads: SystemDefaultReads,
  selectedAccountId: string,
  saved: ClaudeManagedAccount | undefined
): boolean {
  const selected = reads.accountLogin(selectedAccountId) ?? saved
  const systemDefault = reads.systemDefaultLogin(5_000)
  return !selected || !systemDefault || !isSameClaudeLogin(selected, systemDefault)
}
