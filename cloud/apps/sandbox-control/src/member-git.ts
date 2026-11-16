// Git and gh as the workspace's owner. Workspaces are never shared: only the owner can use one, so the owner
// always acts. If they connected GitHub they get a placeholder of their own; the VM's git and gh send it
// (orca-git-identity hands it to every process, no sender attestation: there is no one else to tell apart), and
// the egress proxy swaps it for their GitHub user token, only for the workspace repository (git smart HTTP on
// github.com; on api.github.com REST under /repos/<owner>/<repo> and allowlisted GraphQL mutations pinned to it).
// Tokens never enter the VM. Approvals are refused outright (github-approval-guard.ts).
import type { ProxiedRoute } from './egress-proxy'
import { parseGitHubRepo } from './github-app'
import { getUserTokenRow, memberPlaceholder, type MemberGitIdentity } from './github-user-tokens'
import { gitBasicAuthorization } from './network-policy'
import { UNNORMALIZED_WRITE_REFUSAL, approvalCheckReadsBody, approvalRefusal, requestApproves, unnormalizedWrite } from './github-approval-guard'
import { MEMBER_OUT_OF_REPO_BODY, NODE_REPOSITORY_QUERY, classifyGraphqlRequest, repositoryIdOfNode, type MemberTarget } from './github-graphql-pin'
import { settledCache } from './settled-cache'
import type { SandboxRow } from './store'

export type MemberGitDeps = {
  db: D1Database
  identity: (row: SandboxRow, userId: string) => Promise<MemberGitIdentity | null>
  /**
   * Member gh: the App's installation token for this workspace (`Bearer …`), for what the owner's gh sends
   * that isn't theirs to sign (queries, other API calls), and to check where a mutation's targets live.
   */
  appAuthorization?: (row: SandboxRow) => Promise<string | null>
  fetch?: typeof fetch
}

/**
 * The identity rule: the owner always acts as themselves, and no one else ever does. Except a workspace that ever
 * changed hands: its disk is the previous owner's, and whatever they left there runs at every
 * boot, so it never acts as the new owner on GitHub either; git and gh go out as the App (the same reasoning as
 * shared credential mode, shared-workspace.ts).
 */
export function memberMayAct(row: Pick<SandboxRow, 'user_id' | 'ownership_transferred_at'>, userId: string): boolean {
  return userId === row.user_id && row.ownership_transferred_at == null
}

/** Whose GitHub identity this workspace may use: its owner, once connected (else none; none after a transfer). */
export async function connectedMembers(db: D1Database, row: SandboxRow): Promise<string[]> {
  if (row.ownership_transferred_at != null) {
    return []
  }
  const token = await db
    .prepare('SELECT user_id FROM github_user_tokens WHERE account_id = ? AND user_id = ?')
    .bind(row.account_id, row.user_id)
    .first<{ user_id: string }>()
  return token ? [token.user_id] : []
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
                readsBody: (method, path) => (method.toUpperCase() === 'POST' && (path.split('?')[0] ?? '').toLowerCase() === '/graphql') || approvalCheckReadsBody(method, path),
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
        // Member gh: the same placeholder for gh (GH_TOKEN), swapped at egress on api.github.com.
        ghToken: await memberPlaceholder(row.id, userId),
        // The member's paired orcad devices: orca-git-identity maps orcad's attested sender to a member.
        deviceIds: await memberDeviceIds(deps.db, row.id, userId)
      })
    }
  }
  return out
}

/**
 * An owner who connected GitHub but whose identity can't be used right now (token expired and
 * not refreshable, or member git off for the account). Their commits fall back to the workspace identity, so
 * the VM adds a `Co-authored-by` trailer with their GitHub noreply address: attribution survives, no token.
 */
export async function memberCoauthors(db: D1Database, row: SandboxRow, installed: ReadonlySet<string>) {
  const out: { userId: string; coauthor: string; deviceIds: string[] }[] = []
  for (const userId of await connectedMembers(db, row)) {
    if (installed.has(userId)) {
      continue
    }
    const token = await getUserTokenRow(db, row.account_id, userId)
    const coauthor = token ? coauthorTrailer(token.github_login, token.github_user_id, token.github_name) : null
    if (coauthor) {
      out.push({ userId, coauthor, deviceIds: await memberDeviceIds(db, row.id, userId) })
    }
  }
  return out
}

/** `Name <id+login@users.noreply.github.com>` (GitHub attributes by that address), or null if the parts are odd. */
export function coauthorTrailer(login: string, githubUserId: number, name: string | null): string | null {
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(login) || !Number.isSafeInteger(githubUserId) || githubUserId <= 0) {
    return null
  }
  const display = name && /^[\p{L}\p{N} .'_-]{1,80}$/u.test(name.trim()) ? name.trim() : login
  return `${display} <${githubUserId}+${login}@users.noreply.github.com>`
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
 * Member gh on api.github.com with a member's placeholder (their gh): the member's own token only where it
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
  // No approval ever leaves a workspace, on any identity (github-approval-guard.ts). A write whose path GitHub
  // would normalize differently than this check reads it is refused first.
  if (unnormalizedWrite(request.method, request.path)) {
    return UNNORMALIZED_WRITE_REFUSAL
  }
  if (requestApproves(request)) {
    return approvalRefusal(request.path)
  }
  const app = () => (deps.appAuthorization ? deps.appAuthorization(row) : Promise.resolve(null))
  const pathname = request.path.split('?')[0] ?? ''
  const isGraphql = request.method.toUpperCase() === 'POST' && pathname === '/graphql'
  if (!isGraphql) {
    if (allowed(request.method, request.path)) {
      const id = await identity()
      return id ? `Bearer ${id.token}` : app()
    }
    return app()
  }
  const verdict = classifyGraphqlRequest(request.body ?? '')
  if (!verdict.member) {
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
    // Keyed by this workspace's repository (what its installation token can see), and a failed lookup
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

/** A pull request review, or a pending review's submission (case-insensitive, optional trailing slash). */
