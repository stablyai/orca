import type { ClaudeManagedAccount } from '../../shared/managed-account-types'
import {
  beginClaudeAccountHostMutation,
  countClaudePinnedAccountUsers
} from './claude-pinned-pty-registry'

export type ClaudeAccountHostMutation = 'select' | 'remove' | 'reauthenticate'

const ACTION_PHRASES: Record<ClaudeAccountHostMutation, string> = {
  select: 'switch to',
  remove: 'remove',
  reauthenticate: 're-authenticate'
}

/**
 * Claims a managed account for a change to its host-side credentials or auth dir.
 *
 * Selecting materializes it into ~/.claude, removing deletes the dir a pinned Claude runs from,
 * and re-authenticating replaces the credential a pinned Claude refreshes; each would leave one
 * single-use refresh token in two places or none. The claim is one synchronous check-and-set
 * against pinned reservations, so a launch reserving concurrently is refused instead of racing
 * past a check that already passed. Hold it until every write is done.
 */
export function claimClaudeAccountForHostMutation(
  account: ClaudeManagedAccount,
  action: ClaudeAccountHostMutation
): () => void {
  const release = beginClaudeAccountHostMutation(account.id)
  if (!release) {
    throwPinnedAccountInUse(account, action)
  }
  return release
}

/** A non-claiming early check, for failing before a slow step such as a browser login. */
export function assertClaudeAccountNotPinned(
  account: ClaudeManagedAccount,
  action: ClaudeAccountHostMutation
): void {
  if (countClaudePinnedAccountUsers(account.id) > 0) {
    throwPinnedAccountInUse(account, action)
  }
}

function throwPinnedAccountInUse(
  account: ClaudeManagedAccount,
  action: ClaudeAccountHostMutation
): never {
  const users = countClaudePinnedAccountUsers(account.id)
  const terminals = users === 1 ? '1 terminal' : `${users} terminals`
  throw new Error(
    `Claude account ${account.email} is in use by ${terminals} launched with --account. Close ${users === 1 ? 'it' : 'them'} before you ${ACTION_PHRASES[action]} this account.`
  )
}
