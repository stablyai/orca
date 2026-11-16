// GIT-ACTOR: who a workspace's GitHub actions (pushes, PRs, comments) go out as right now, for the desktop's
// "Pushes and PRs go out as @login" line. The same rule the egress proxy applies (member-git.ts actingMember);
// the desktop never recomputes it. Approvals always, and merges in shared workspaces, still go out as the bot.
import { parseGitHubRepo } from './github-app'
import { getUserTokenRow, type GitHubUserTokenRow } from './github-user-tokens'
import { actingMember } from './member-git'
import type { SandboxRow } from './store'

export type GitActor =
  | { kind: 'member'; userId: string; login: string; until?: number }
  | { kind: 'bot'; reason: 'no_connected_member' | 'stale' }

/** Usable without a reconnect: an access token still valid, or a refresh token that can renew it. */
function usable(token: GitHubUserTokenRow | null, now: number): token is GitHubUserTokenRow {
  return Boolean(
    token && (token.access_expires_at === null || token.access_expires_at > now || (token.refresh_expires_at !== null && token.refresh_expires_at > now))
  )
}

/** Null when it doesn't apply (not a GitHub repo, or GH-AS-MEMBER off for this account): the desktop shows nothing. */
export async function gitActorView(
  db: D1Database,
  row: SandboxRow,
  viewerUserId: string,
  now: number,
  options: { enabled: boolean; sharedMaxMs: number | null }
): Promise<{ gitActor: GitActor; viewerConnected: boolean } | null> {
  if (!options.enabled || !row.repo_url || !parseGitHubRepo(row.repo_url)) {
    return null
  }
  const [acting, viewer] = await Promise.all([actingMember(db, row, now, options.sharedMaxMs), getUserTokenRow(db, row.account_id, viewerUserId)])
  const viewerConnected = usable(viewer, now)
  if ('none' in acting) {
    return { gitActor: { kind: 'bot', reason: acting.none === 'stale' ? 'stale' : 'no_connected_member' }, viewerConnected }
  }
  const token = acting.userId === viewerUserId ? viewer : await getUserTokenRow(db, row.account_id, acting.userId)
  if (!usable(token, now)) {
    return { gitActor: { kind: 'bot', reason: 'no_connected_member' }, viewerConnected }
  }
  return {
    gitActor: { kind: 'member', userId: acting.userId, login: token.github_login, ...(acting.until !== null ? { until: acting.until } : {}) },
    viewerConnected
  }
}
