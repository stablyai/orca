// Deleting a team (auth's POST /v1/desktop/orgs/:orgId/delete). Auth holds MEMBER_REMOVED_TOKEN,
// which is good for these two routes and the member-removed push, never the operator routes.
//
//   GET  /v1/internal/accounts/:accountId/delete-check   -> { workspaces }
//   POST /v1/internal/accounts/:accountId/secrets/purge  -> { purged }
//
// A team can only be deleted once it has no cloud workspaces in any state (running, asleep or
// archived): the user deletes them first through the normal workspace delete, which destroys the
// sandbox and its snapshots. Then auth purges the team's cloud secrets (org-scoped and the team's
// repo-scoped ones; members' personal secrets are theirs) and deletes the team.

const ACCOUNT_PATH = /^\/v1\/internal\/accounts\/((?:org|dev:org):[A-Za-z0-9_.:-]{1,150})\/(delete-check|secrets\/purge)$/

export type TeamDeleteRoute = { accountId: string; action: 'delete-check' | 'secrets/purge' }

/** The route and team account id, or null for any other path or method. */
export function teamDeleteRoute(pathname: string, method: string): TeamDeleteRoute | null {
  const match = ACCOUNT_PATH.exec(pathname)
  if (!match) {
    return null
  }
  const action = match[2] as TeamDeleteRoute['action']
  if ((action === 'delete-check' && method !== 'GET') || (action === 'secrets/purge' && method !== 'POST')) {
    return null
  }
  return { accountId: match[1]!, action }
}

/** Cloud workspaces the team still has, in any state but destroyed. */
export async function teamWorkspaceCount(db: D1Database, accountId: string): Promise<number> {
  const row = await db
    .prepare(`SELECT COUNT(*) AS n FROM sandboxes WHERE account_id = ? AND status <> 'destroyed'`)
    .bind(accountId)
    .first<{ n: number }>()
  return Number(row?.n ?? 0)
}

/**
 * Deletes the team's cloud secrets. Refuses while workspaces remain, so a running sandbox never
 * loses a secret it was started with; auth checks first, this is the backstop.
 */
export async function purgeTeamSecrets(
  db: D1Database,
  accountId: string
): Promise<{ ok: true; purged: number } | { ok: false; workspaces: number }> {
  const workspaces = await teamWorkspaceCount(db, accountId)
  if (workspaces > 0) {
    return { ok: false, workspaces }
  }
  // repo secrets are owned by '<account id>#<repo>'; escape LIKE wildcards in the account id.
  const prefix = `${accountId.replace(/[\\%_]/g, (char) => `\\${char}`)}#%`
  const [result] = await db.batch([
    db
      .prepare(
        `DELETE FROM secrets WHERE (scope = 'org' AND owner_id = ?) OR (scope = 'repo' AND owner_id LIKE ? ESCAPE '\\')`
      )
      .bind(accountId, prefix),
    // The team's secret activity (names, who, when) goes with the team.
    db.prepare('DELETE FROM secret_events WHERE account_id = ?').bind(accountId)
  ])
  return { ok: true, purged: Number(result?.meta?.changes ?? 0) }
}
