// Git as the sender. Every member with access to a workspace (its owner and anyone holding an active
// grant) who connected GitHub gets a placeholder of their own. The VM's `orca-git-as <member>` sends
// it; the egress proxy swaps it for that member's GitHub user token, and only for the workspace
// repository (git smart HTTP on github.com, REST under /repos/<owner>/<repo> on api.github.com).
// Who may use which identity is decided in the VM by orcad's attestation: orca-git-identity (root)
// maps the paired device that sent the agent's latest turn to a member and refuses any other member;
// member files are root-only. Tokens never enter the VM and work for this repository only. Residual
// risk: members share the VM user, so a member with a shell could subvert orcad itself.
import type { ProxiedRoute } from './egress-proxy'
import { parseGitHubRepo } from './github-app'
import { memberPlaceholder, type MemberGitIdentity } from './github-user-tokens'
import { gitBasicAuthorization } from './network-policy'
import { MEMBER_OUT_OF_REPO_BODY, NODE_REPOSITORY_QUERY, approves, classifyGraphqlRequest, merges, repositoryIdOfNode, type MemberTarget } from './github-graphql-pin'
import { settledCache } from './settled-cache'
import type { SandboxRow } from './store'

/** A member's GitHub identity works only this long after they themselves sent a message (default). */
export const MEMBER_GIT_WINDOW_MS = 30 * 60_000

/** Their own client reports each send (their Orca token): the window cannot be opened from the VM. */
export async function recordMemberSend(db: D1Database, sandboxId: string, userId: string, now: number): Promise<void> {
  await db
    .prepare(
      `INSERT INTO workspace_member_sends (sandbox_id, user_id, sent_at) VALUES (?, ?, ?)
       ON CONFLICT (sandbox_id, user_id) DO UPDATE SET sent_at = excluded.sent_at`
    )
    .bind(sandboxId, userId, now)
    .run()
}

export async function memberSentWithin(db: D1Database, sandboxId: string, userId: string, now: number, windowMs: number): Promise<boolean> {
  const row = await db
    .prepare('SELECT sent_at FROM workspace_member_sends WHERE sandbox_id = ? AND user_id = ?')
    .bind(sandboxId, userId)
    .first<{ sent_at: number }>()
  return row !== null && now - row.sent_at <= windowMs
}

export type MemberGitDeps = {
  db: D1Database
  identity: (row: SandboxRow, userId: string) => Promise<MemberGitIdentity | null>
  /**
   * GH-AS-MEMBER: the App's installation token for this workspace (`Bearer …`), for what a member's gh sends
   * that isn't theirs to sign (queries, other API calls), and to check where a mutation's targets live.
   */
  appAuthorization?: (row: SandboxRow) => Promise<string | null>
  fetch?: typeof fetch
}

/**
 * GH-AS-MEMBER identity rule (replaces the 30-minute window, which lapsed while an agent was still working
 * on its sender's request): in a workspace only one person can use, that person always acts as themselves;
 * in a shared one, the latest member to send a message acts until a different member sends, for at most
 * MEMBER_GIT_SHARED_MAX_MINUTES after that send (default 60 min). Approvals never carry a member's identity, and
 * merges do only in a one-person workspace (review M2).
 */
export async function memberMayAct(db: D1Database, row: SandboxRow, userId: string, now: number, sharedMaxMs: number | null): Promise<boolean> {
  const ownerToo = row.ownership_transferred_at == null
  const { results } = await db
    .prepare(`SELECT DISTINCT user_id FROM workspace_grants WHERE sandbox_id = ? AND status = 'active'`)
    .bind(row.id)
    .all<{ user_id: string }>()
  const people = new Set(results.map((r) => r.user_id))
  if (ownerToo) {
    people.add(row.user_id)
  }
  if (people.size === 1) {
    return people.has(userId)
  }
  const latest = await db
    .prepare('SELECT user_id, sent_at FROM workspace_member_sends WHERE sandbox_id = ? ORDER BY sent_at DESC LIMIT 1')
    .bind(row.id)
    .first<{ user_id: string; sent_at: number }>()
  return latest?.user_id === userId && people.has(userId) && (sharedMaxMs === null || now - latest.sent_at <= sharedMaxMs)
}

/** Members whose GitHub identity this workspace may use: owner + active grantees, connected only. */
export async function connectedMembers(db: D1Database, row: SandboxRow): Promise<string[]> {
  // OWNER-TRANSFER: on a transferred workspace the owner has no entry of their own. They count
  // only while they hold an active grant, exactly like any member of a shared workspace.
  const ownerToo = row.ownership_transferred_at == null
  const { results } = await db
    .prepare(
      `SELECT t.user_id FROM github_user_tokens t WHERE t.account_id = ? AND ((? = 1 AND t.user_id = ?) OR t.user_id IN
         (SELECT g.user_id FROM workspace_grants g WHERE g.sandbox_id = ? AND g.status = 'active'))
       ORDER BY t.user_id`
    )
    .bind(row.account_id, ownerToo ? 1 : 0, row.user_id, row.id)
    .all<{ user_id: string }>()
  return results.map((r) => r.user_id)
}

export function repoPathAllowed(repoUrl: string | null, host: string): (method: string, path: string) => boolean {
  const repo = repoUrl ? parseGitHubRepo(repoUrl) : null
  if (!repo) {
    return () => false
  }
  const owner = repo.owner.toLowerCase()
  const name = repo.repo.toLowerCase()
  return (_method, path) => {
    const lower = path.split('?')[0]!.toLowerCase()
    if (lower.includes('..') || lower.includes('%2e') || lower.includes('//')) {
      return false
    }
    if (host === 'github.com') {
      return lower.startsWith(`/${owner}/${name}.git/`) || lower.startsWith(`/${owner}/${name}/info/`) ||
        lower === `/${owner}/${name}/git-upload-pack` || lower === `/${owner}/${name}/git-receive-pack`
    }
    return lower === `/repos/${owner}/${name}` || lower.startsWith(`/repos/${owner}/${name}/`)
  }
}

export function memberGitRoutes(deps: MemberGitDeps) {
  return {
    async routes(row: SandboxRow, host: string): Promise<ProxiedRoute[]> {
      const allowed = repoPathAllowed(row.repo_url, host)
      const routes: ProxiedRoute[] = []
      for (const userId of await connectedMembers(deps.db, row)) {
        const placeholder = await memberPlaceholder(row.id, userId)
        const identity = () => deps.identity(row, userId)
        routes.push(
          host === 'github.com'
            ? {
                header: 'authorization',
                placeholders: [gitBasicAuthorization(placeholder)],
                credential: async () => {
                  const id = await identity()
                  return id ? gitBasicAuthorization(id.token) : null
                },
                pathAllowed: allowed
              }
            : {
                header: 'authorization',
                placeholders: [`Bearer ${placeholder}`, `token ${placeholder}`],
                readsBody: (method, path) =>
                  (method.toUpperCase() === 'POST' && path.split('?')[0] === '/graphql') || /\/pulls\/\d+\/reviews(\/\d+\/events)?$/.test(path.split('?')[0] ?? ''),
                credential: async (request) => memberApiCredential(deps, row, identity, allowed, request)
              }
        )
      }
      return routes
    }
  }
}

/** What the VM writes per member for `orca-git-as` (no token: the placeholder and author identity). */
export async function memberGitConfigs(deps: MemberGitDeps, row: SandboxRow) {
  const out: { userId: string; name: string; email: string; authorization: string; ghToken: string; deviceIds: string[] }[] = []
  for (const userId of await connectedMembers(deps.db, row)) {
    const identity = await deps.identity(row, userId)
    if (identity) {
      out.push({
        userId,
        name: identity.name,
        email: identity.email,
        authorization: gitBasicAuthorization(await memberPlaceholder(row.id, userId)),
        // GH-AS-MEMBER: the same placeholder for gh (GH_TOKEN), swapped at egress on api.github.com.
        ghToken: await memberPlaceholder(row.id, userId),
        // The member's paired orcad devices: orca-git-identity maps orcad's attested sender to a member.
        deviceIds: await memberDeviceIds(deps.db, row.id, userId)
      })
    }
  }
  return out
}

async function memberDeviceIds(db: D1Database, sandboxId: string, userId: string): Promise<string[]> {
  const { results } = await db
    .prepare(
      `SELECT orcad_device_id FROM workspace_grants WHERE sandbox_id = ? AND user_id = ? AND status = 'active' AND orcad_device_id IS NOT NULL`
    )
    .bind(sandboxId, userId)
    .all<{ orcad_device_id: string }>()
  return results.map((r) => r.orcad_device_id)
}

/**
 * GH-AS-MEMBER, api.github.com with a member's placeholder (their gh): the member's own token only where it
 * is pinned to the workspace repository (REST under /repos/<owner>/<repo>, and allowlisted GraphQL mutations
 * whose every target resolves to that repository); everything else goes out on the App's installation token,
 * exactly as before the member's gh carried their placeholder. A pinned mutation aimed elsewhere is refused.
 */
async function memberApiCredential(
  deps: MemberGitDeps,
  row: SandboxRow,
  identity: () => Promise<MemberGitIdentity | null>,
  allowed: (method: string, path: string) => boolean,
  request: { method: string; path: string; body: string | null }
): ReturnType<ProxiedRoute['credential']> {
  const app = () => (deps.appAuthorization ? deps.appAuthorization(row) : Promise.resolve(null))
  const pathname = request.path.split('?')[0] ?? ''
  const isGraphql = request.method.toUpperCase() === 'POST' && pathname === '/graphql'
  if (!isGraphql) {
    if (allowed(request.method, request.path)) {
      // Review M2: a REST approval never carries a member's identity; a merge does only in a one-person workspace.
      if (restApproves(request) || (restMerges(request) && (await isSharedWorkspace(deps.db, row)))) {
        return app()
      }
      const id = await identity()
      return id ? `Bearer ${id.token}` : app()
    }
    return app()
  }
  const verdict = classifyGraphqlRequest(request.body ?? '')
  if (!verdict.member) {
    return app()
  }
  if (approves(verdict.fields) || (merges(verdict.fields) && (await isSharedWorkspace(deps.db, row)))) {
    return app()
  }
  const id = await identity()
  if (!id) {
    return app()
  }
  const appToken = await app()
  const pinned = appToken ? await targetsInWorkspaceRepo(deps, row, appToken, verdict.targets) : false
  if (!pinned) {
    return { deny: 'member_graphql_out_of_repo', answer: { status: 403, contentType: 'application/json', body: MEMBER_OUT_OF_REPO_BODY } }
  }
  return `Bearer ${id.token}`
}

// Settled values only (settled-cache.ts): the workspace repository's node id, and which repository a node is in.
const repoNodeIds = settledCache<string | null>(60 * 60_000)
const nodeRepositories = settledCache<string | null>(10 * 60_000)

async function targetsInWorkspaceRepo(deps: MemberGitDeps, row: SandboxRow, appToken: string, targets: readonly MemberTarget[]): Promise<boolean> {
  const repo = row.repo_url ? parseGitHubRepo(row.repo_url) : null
  if (!repo) {
    return false
  }
  const doFetch = deps.fetch ?? fetch
  const headers = { authorization: appToken, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'orca-sandbox-control' }
  const now = Date.now()
  const repoId = await repoNodeIds
    .get(`${repo.owner}/${repo.repo}`.toLowerCase(), now, async () => {
      const response = await doFetch(`https://api.github.com/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}`, { headers })
      const body = (await response.json().catch(() => null)) as { node_id?: unknown } | null
      if (!response.ok || typeof body?.node_id !== 'string') {
        throw new Error(`repo lookup ${response.status}`)
      }
      return body.node_id
    })
    .catch(() => null)
  if (!repoId) {
    return false
  }
  for (const target of targets) {
    if (target.kind === 'repository') {
      if (target.id !== repoId) {
        return false
      }
      continue
    }
    // Review L1: keyed by this workspace's repository (what its installation token can see), and a failed lookup
    // isn't cached. A node's repository rarely changes (an issue can be transferred: the cache bounds that to 10 min).
    const owner: string | null = await nodeRepositories
      .get(`${repoId}:${target.id}`, now, async () => {
        const response = await doFetch('https://api.github.com/graphql', {
          method: 'POST',
          headers: { ...headers, 'content-type': 'application/json' },
          body: JSON.stringify({ query: NODE_REPOSITORY_QUERY, variables: { id: target.id } })
        })
        if (!response.ok) {
          throw new Error(`node lookup ${response.status}`)
        }
        return repositoryIdOfNode(await response.json().catch(() => null))
      })
      .catch(() => null)
    if (owner !== repoId) {
      return false
    }
  }
  return true
}

/** REST approval: a review, or a pending review's submission, with event APPROVE (any case). */
function restApproves(request: { method: string; path: string; body: string | null }): boolean {
  const pathname = request.path.split('?')[0] ?? ''
  if (request.method.toUpperCase() !== 'POST' || !/\/pulls\/\d+\/reviews(\/\d+\/events)?$/.test(pathname)) {
    return false
  }
  try {
    const event = (JSON.parse(request.body ?? '{}') as { event?: unknown } | null)?.event
    return String(event ?? '').toUpperCase() === 'APPROVE'
  } catch {
    // Unreadable: treat as an approval (fails toward the installation token).
    return true
  }
}

/** REST merge: a pull request's (PUT …/pulls/N/merge) or a branch into another (POST /repos/o/r/merges). */
function restMerges(request: { method: string; path: string }): boolean {
  const pathname = request.path.split('?')[0] ?? ''
  const method = request.method.toUpperCase()
  return (method === 'PUT' && /\/pulls\/\d+\/merge$/.test(pathname)) || (method === 'POST' && /^\/repos\/[^/]+\/[^/]+\/merges$/.test(pathname))
}

/** More than one person can use this workspace (owner plus other active grantees). */
async function isSharedWorkspace(db: D1Database, row: SandboxRow): Promise<boolean> {
  const { results } = await db.prepare(`SELECT DISTINCT user_id FROM workspace_grants WHERE sandbox_id = ? AND status = 'active'`).bind(row.id).all<{ user_id: string }>()
  const people = new Set(results.map((r) => r.user_id))
  if (row.ownership_transferred_at == null) {
    people.add(row.user_id)
  }
  return people.size > 1
}
