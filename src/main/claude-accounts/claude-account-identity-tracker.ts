import type { ClaudeAccountIdentityStatus } from './claude-account-identity-status'

/**
 * Holds the most recent identity verdict per account.
 *
 * Why a tracker rather than computing it inside the snapshot: the verdict needs the account's own
 * `.claude.json`, and the snapshot builder is synchronous and called on every render of the status
 * bar. Reading the filesystem there would put disk I/O on that path. Instead the lanes that already
 * touch the account's home — pane launch and the usage read — record what they saw, and the
 * snapshot merges the last verdict in by account id.
 *
 * An account with no recorded verdict is absent from the map, and callers render `unknown`. That is
 * deliberate: "we have not looked yet" and "we looked and could not tell" are both states in which
 * telling the user their account is someone else's would be wrong.
 */
export class ClaudeAccountIdentityTracker {
  private readonly statuses = new Map<string, ClaudeAccountIdentityStatus>()

  /** Returns true when the verdict changed, which is the caller's cue to publish a snapshot. */
  record(accountId: string, status: ClaudeAccountIdentityStatus): boolean {
    if (this.statuses.get(accountId) === status) {
      return false
    }
    this.statuses.set(accountId, status)
    return true
  }

  get(accountId: string): ClaudeAccountIdentityStatus | undefined {
    return this.statuses.get(accountId)
  }

  forget(accountId: string): void {
    this.statuses.delete(accountId)
  }
}
