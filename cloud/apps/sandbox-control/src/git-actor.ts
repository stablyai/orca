// GIT-ACTOR: who a workspace's GitHub actions (pushes, PRs, comments) go out as right now, on the workspace view
// (`githubActing`, plus the viewer's own connection as `you`). The same rule the egress proxy applies
// (member-git.ts actingMember); the desktop never recomputes it. Approvals always, and merges in shared
// workspaces, still go out as the bot.
import { parseGitHubRepo } from './github-app'
import type { GitHubUserTokenRow } from './github-user-tokens'
import { pickActing } from './member-git'
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

/**
 * The view for every row at once, in a fixed number of reads whatever the list size: active grants and sends
 * for all rows, then the GitHub connections of everyone involved (the viewer and each row's acting member).
 */
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
  const live = rows.filter((row) => row.repo_url && parseGitHubRepo(row.repo_url) && options.enabled(row.account_id))
  const ids = live.map((row) => row.id)
  const [grants, sends] = await Promise.all([
    inChunks(ids, (chunk) =>
      db
        .prepare(`SELECT DISTINCT sandbox_id, user_id FROM workspace_grants WHERE status = 'active' AND sandbox_id IN (${marks(chunk)})`)
        .bind(...chunk)
        .all<{ sandbox_id: string; user_id: string }>()
        .then((r) => r.results)
    ),
    inChunks(ids, (chunk) =>
      db
        .prepare(`SELECT sandbox_id, user_id, sent_at FROM workspace_member_sends WHERE sandbox_id IN (${marks(chunk)})`)
        .bind(...chunk)
        .all<{ sandbox_id: string; user_id: string; sent_at: number }>()
        .then((r) => r.results)
    )
  ])
  const granteesOf = new Map<string, string[]>()
  for (const g of grants) {
    granteesOf.set(g.sandbox_id, [...(granteesOf.get(g.sandbox_id) ?? []), g.user_id])
  }
  const latestOf = new Map<string, { user_id: string; sent_at: number }>()
  for (const send of sends) {
    const seen = latestOf.get(send.sandbox_id)
    if (!seen || send.sent_at > seen.sent_at) {
      latestOf.set(send.sandbox_id, send)
    }
  }
  const acting = new Map(live.map((row) => [row.id, pickActing(row, granteesOf.get(row.id) ?? [], latestOf.get(row.id) ?? null, now, options.sharedMaxMs)]))
  // One read per account (normally one) for every connection the views need.
  const tokens = new Map<string, GitHubUserTokenRow>()
  const key = (accountId: string, userId: string) => `${accountId}\u0000${userId}`
  const accounts = new Map<string, Set<string>>()
  for (const row of rows) {
    const users = accounts.get(row.account_id) ?? new Set<string>([viewerUserId])
    const pick = acting.get(row.id)
    if (pick && 'userId' in pick) {
      users.add(pick.userId)
    }
    accounts.set(row.account_id, users)
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
    out.set(row.id, { githubActing: decide(row, acting.get(row.id), tokens, key, now, options), you: usable(viewer, now) ? { connected: true, login: viewer.github_login } : { connected: false } })
  }
  return out
}

function decide(
  row: SandboxRow,
  pick: ReturnType<typeof pickActing> | undefined,
  tokens: ReadonlyMap<string, GitHubUserTokenRow>,
  key: (accountId: string, userId: string) => string,
  now: number,
  options: GithubActingOptions
): GithubActing {
  if (!row.repo_url || !parseGitHubRepo(row.repo_url)) {
    return { actingAs: 'bot', reason: 'not_github' }
  }
  if (!options.enabled(row.account_id) || !pick) {
    return { actingAs: 'bot', reason: 'off' }
  }
  if ('none' in pick) {
    return { actingAs: 'bot', reason: pick.none === 'stale' ? 'window_expired' : 'no_sender_yet' }
  }
  const token = tokens.get(key(row.account_id, pick.userId)) ?? null
  if (!token) {
    return { actingAs: 'bot', reason: 'sender_not_connected' }
  }
  if (!usable(token, now)) {
    return { actingAs: 'bot', reason: 'reconnect' }
  }
  return { actingAs: 'member', userId: pick.userId, login: token.github_login, ...(pick.until !== null ? { until: pick.until } : {}) }
}
