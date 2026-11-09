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
  const out: { userId: string; name: string; email: string; authorization: string; deviceIds: string[] }[] = []
  for (const userId of await connectedMembers(deps.db, row)) {
    const identity = await deps.identity(row, userId)
    if (identity) {
      out.push({
        userId,
        name: identity.name,
        email: identity.email,
        authorization: gitBasicAuthorization(await memberPlaceholder(row.id, userId)),
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
