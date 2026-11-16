// GIT-ACTOR: who a workspace's GitHub actions (pushes, PRs, comments) go out as right now, on the workspace view
// (`githubActing`, plus the viewer's own connection as `you`). The same rule the egress proxy applies
// (member-git.ts actingMember); the desktop never recomputes it. Approvals always, and merges in shared
// workspaces, still go out as the bot.
import { parseGitHubRepo } from './github-app'
import { getUserTokenRow, type GitHubUserTokenRow } from './github-user-tokens'
import { actingMember } from './member-git'
import type { SandboxRow } from './store'

export type GithubActing =
  | { actingAs: 'member'; userId: string; login: string; until?: number }
  | { actingAs: 'bot'; reason: 'not_github' | 'off' | 'no_sender_yet' | 'sender_not_connected' | 'reconnect' | 'window_expired' }

/** The env side: whether GH-AS-MEMBER applies to an account, and the shared-workspace cap. */
export type GithubActingOptions = { enabled: (accountId: string) => boolean; sharedMaxMs: number | null }

/** Usable without a reconnect: an access token still valid, or a refresh token that can renew it. */
function usable(token: GitHubUserTokenRow | null, now: number): token is GitHubUserTokenRow {
  return Boolean(
    token && (token.access_expires_at === null || token.access_expires_at > now || (token.refresh_expires_at !== null && token.refresh_expires_at > now))
  )
}

export async function githubActingView(
  db: D1Database,
  row: SandboxRow,
  viewerUserId: string,
  now: number,
  options: GithubActingOptions
): Promise<{ githubActing: GithubActing; you: { connected: boolean; login?: string } }> {
  const viewer = await getUserTokenRow(db, row.account_id, viewerUserId)
  const you = usable(viewer, now) ? { connected: true, login: viewer.github_login } : { connected: false }
  if (!row.repo_url || !parseGitHubRepo(row.repo_url)) {
    return { githubActing: { actingAs: 'bot', reason: 'not_github' }, you }
  }
  if (!options.enabled(row.account_id)) {
    return { githubActing: { actingAs: 'bot', reason: 'off' }, you }
  }
  const acting = await actingMember(db, row, now, options.sharedMaxMs)
  if ('none' in acting) {
    return { githubActing: { actingAs: 'bot', reason: acting.none === 'stale' ? 'window_expired' : 'no_sender_yet' }, you }
  }
  const token = acting.userId === viewerUserId ? viewer : await getUserTokenRow(db, row.account_id, acting.userId)
  if (!token) {
    return { githubActing: { actingAs: 'bot', reason: 'sender_not_connected' }, you }
  }
  if (!usable(token, now)) {
    return { githubActing: { actingAs: 'bot', reason: 'reconnect' }, you }
  }
  return {
    githubActing: { actingAs: 'member', userId: acting.userId, login: token.github_login, ...(acting.until !== null ? { until: acting.until } : {}) },
    you
  }
}
