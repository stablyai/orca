// Git as the sender. Every member with access to a workspace (its owner and anyone holding an active
// grant) who connected GitHub gets a placeholder of their own. The VM's `orca-git-as <member>` sends
// it; the egress proxy swaps it for that member's GitHub user token, and only for the workspace
// repository (git smart HTTP on github.com, REST under /repos/<owner>/<repo> on api.github.com).
// Trust note: members of a shared workspace share one VM user, so a member can push as another
// member of the same workspace to the same repository; tokens never enter the VM and cannot be
// used for any other repository or API.
import type { ProxiedRoute } from './egress-proxy'
import { parseGitHubRepo } from './github-app'
import { memberPlaceholder, type MemberGitIdentity } from './github-user-tokens'
import { gitBasicAuthorization } from './network-policy'
import type { SandboxRow } from './store'

export type MemberGitDeps = {
  db: D1Database
  identity: (row: SandboxRow, userId: string) => Promise<MemberGitIdentity | null>
}

/** Members whose GitHub identity this workspace may use: owner + active grantees, connected only. */
export async function connectedMembers(db: D1Database, row: SandboxRow): Promise<string[]> {
  const { results } = await db
    .prepare(
      `SELECT t.user_id FROM github_user_tokens t WHERE t.account_id = ? AND (t.user_id = ? OR t.user_id IN
         (SELECT g.user_id FROM workspace_grants g WHERE g.sandbox_id = ? AND g.status = 'active'))
       ORDER BY t.user_id`
    )
    .bind(row.account_id, row.user_id, row.id)
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
                credential: async () => {
                  const id = await identity()
                  return id ? `Bearer ${id.token}` : null
                },
                pathAllowed: allowed
              }
        )
      }
      return routes
    }
  }
}

/** What the VM writes per member for `orca-git-as` (no token: the placeholder and author identity). */
export async function memberGitConfigs(deps: MemberGitDeps, row: SandboxRow) {
  const out: { userId: string; name: string; email: string; authorization: string }[] = []
  for (const userId of await connectedMembers(deps.db, row)) {
    const identity = await deps.identity(row, userId)
    if (identity) {
      out.push({
        userId,
        name: identity.name,
        email: identity.email,
        authorization: gitBasicAuthorization(await memberPlaceholder(row.id, userId))
      })
    }
  }
  return out
}
