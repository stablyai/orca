// GIT-ACTOR: who a workspace's GitHub actions (pushes, PRs, comments) go out as right now, on the workspace view
// (`githubActing`, plus the viewer's own connection as `you`). The owner always acts (member-git.ts memberMayAct):
// as themselves once connected, else as the Orca bot. Approvals always go out as the bot.
import { parseGitHubRepo } from './github-app'
import type { GitHubUserTokenRow } from './github-user-tokens'
import type { SandboxRow } from './store'

export type GithubActing =
  | { actingAs: 'member'; userId: string; login: string }
  | { actingAs: 'bot'; reason: 'not_github' | 'off' | 'transferred' | 'sender_not_connected' | 'reconnect' }

/** The env side: whether GH-AS-MEMBER applies to an account. */
export type GithubActingOptions = { enabled: (accountId: string) => boolean }

/** Usable without a reconnect: an access token still valid, or a refresh token that can renew it. */
function usable(token: GitHubUserTokenRow | null, now: number): token is GitHubUserTokenRow {
  return Boolean(
    token && (token.access_expires_at === null || token.access_expires_at > now || (token.refresh_expires_at !== null && token.refresh_expires_at > now))
  )
}

export type GithubActingView = { githubActing: GithubActing; you: { connected: boolean; login?: string } }

// D1 caps bound parameters per statement; chunk well under it.
async function inChunks<T>(ids: readonly string[], read: (chunk: readonly string[]) => Promise<T[]>): Promise<T[]> {
  const out: T[] = []
  for (let i = 0; i < ids.length; i += 90) {
    out.push(...(await read(ids.slice(i, i + 90))))
  }
  return out
}
const marks = (ids: readonly string[]) => ids.map(() => '?').join(', ')

/** The view for every row at once: one read of GitHub connections per account (the viewer and each owner). */
export async function githubActingViews(
  db: D1Database,
  rows: readonly SandboxRow[],
  viewerUserId: string,
  now: number,
  options: GithubActingOptions
): Promise<Map<string, GithubActingView>> {
  const out = new Map<string, GithubActingView>()
  if (rows.length === 0) {
    return out
  }
  const tokens = new Map<string, GitHubUserTokenRow>()
  const key = (accountId: string, userId: string) => `${accountId}\u0000${userId}`
  const accounts = new Map<string, Set<string>>()
  for (const row of rows) {
    accounts.set(row.account_id, (accounts.get(row.account_id) ?? new Set<string>([viewerUserId])).add(row.user_id))
  }
  for (const [accountId, users] of accounts) {
    const found = await inChunks([...users], (chunk) =>
      db
        .prepare(`SELECT * FROM github_user_tokens WHERE account_id = ? AND user_id IN (${marks(chunk)})`)
        .bind(accountId, ...chunk)
        .all<GitHubUserTokenRow>()
        .then((r) => r.results)
    )
    for (const token of found) {
      tokens.set(key(accountId, token.user_id), token)
    }
  }
  for (const row of rows) {
    const viewer = tokens.get(key(row.account_id, viewerUserId)) ?? null
    out.set(row.id, {
      githubActing: decide(row, tokens.get(key(row.account_id, row.user_id)) ?? null, now, options),
      you: usable(viewer, now) ? { connected: true, login: viewer.github_login } : { connected: false }
    })
  }
  return out
}

function decide(row: SandboxRow, owner: GitHubUserTokenRow | null, now: number, options: GithubActingOptions): GithubActing {
  if (!row.repo_url || !parseGitHubRepo(row.repo_url)) {
    return { actingAs: 'bot', reason: 'not_github' }
  }
  if (!options.enabled(row.account_id)) {
    return { actingAs: 'bot', reason: 'off' }
  }
  // OWNER-TRANSFER: never the new owner on GitHub (member-git.ts memberMayAct).
  if (row.ownership_transferred_at != null) {
    return { actingAs: 'bot', reason: 'transferred' }
  }
  if (!owner) {
    return { actingAs: 'bot', reason: 'sender_not_connected' }
  }
  if (!usable(owner, now)) {
    return { actingAs: 'bot', reason: 'reconnect' }
  }
  return { actingAs: 'member', userId: row.user_id, login: owner.github_login }
}
