// Secret edits reach running sandboxes without a restart or image rebuild: the control plane
// re-resolves the session env and hands it to `orca-sandbox-env` in the VM, which replaces the
// memory-only env file new shells and agent launches read. Processes already running keep the
// values they started with. Egress routes and the allowlist follow the new env first, so a new
// model key is reachable before any shell can see its placeholder.
import { egressPolicy, refreshGitCredentials, type LifecycleDeps } from './lifecycle'
import { ProviderError } from './sandbox-provider'
import { refreshSessionEnv } from './sandbox-vm-commands'
import { normalizeRepo, type SecretChange } from './secrets'
import { sessionSecretEnv } from './session-env'
import { transition, type SandboxRow } from './store'

/** Running sandboxes whose sessions read secrets of this owner. */
export async function sandboxesForSecretOwner(db: D1Database, change: SecretChange): Promise<SandboxRow[]> {
  const running = async (where: string, ...binds: string[]) =>
    (
      await db
        .prepare(`SELECT * FROM sandboxes WHERE status = 'running' AND ${where} LIMIT 200`)
        .bind(...binds)
        .all<SandboxRow>()
    ).results
  switch (change.scope) {
    case 'personal': {
      // `user:<id>` or `dev:user:<id>`; dev callers only own `dev:` accounts' sandboxes.
      const dev = change.ownerId.startsWith('dev:')
      const userId = change.ownerId.slice(change.ownerId.indexOf('user:') + 'user:'.length)
      const rows = await running('user_id = ?', userId)
      return rows.filter((row) => row.account_id.startsWith('dev:') === dev)
    }
    case 'org':
      return running('account_id = ?', change.ownerId)
    case 'repo': {
      const hash = change.ownerId.indexOf('#')
      const accountId = change.ownerId.slice(0, hash)
      const repo = change.ownerId.slice(hash + 1)
      const rows = await running('account_id = ?', accountId)
      return rows.filter((row) => normalizeRepo(row.repo_url) === repo)
    }
  }
}

/** Re-resolves one running session's env and applies it in the VM. False when it could not. */
export async function refreshSandboxEnv(deps: LifecycleDeps, row: SandboxRow): Promise<boolean> {
  if (row.status !== 'running' || !row.session_id || !deps.secrets) {
    return false
  }
  const secrets = await sessionSecretEnv(deps, row)
  let current = row
  if (secrets.egressSecretHosts !== row.egress_secret_hosts || secrets.egressAllowHosts !== row.egress_allow_hosts) {
    const routed: SandboxRow = { ...row, egress_secret_hosts: secrets.egressSecretHosts, egress_allow_hosts: secrets.egressAllowHosts }
    // A policy write replaces the whole policy, so the git route is re-minted alongside.
    const git = await refreshGitCredentials(deps, routed, row.session_id)
    if (!git) {
      await deps.provider.updateNetworkPolicy(row.session_id, egressPolicy(deps, routed))
    }
    const next = await transition(
      deps.db,
      row,
      {
        egress_secret_hosts: routed.egress_secret_hosts,
        egress_allow_hosts: routed.egress_allow_hosts,
        ...(git ? { github_token_expires_at: git.expiresAt } : {})
      },
      deps.now()
    )
    if (!next) {
      // Raced with a lifecycle transition: that boot resolves the env itself.
      return false
    }
    current = next
  }
  try {
    const applied = await refreshSessionEnv(deps.provider, current.session_id!, secrets.env)
    // Counts only.
    console.log(JSON.stringify({ event: 'session_env_refreshed', sandboxId: row.id, applied, names: Object.keys(secrets.env).length }))
    return applied
  } catch (error) {
    if (error instanceof ProviderError) {
      console.log(JSON.stringify({ event: 'session_env_refresh_failed', sandboxId: row.id, code: error.code }))
      return false
    }
    throw error
  }
}

/** After a secret write: refresh every running session that reads that owner's secrets. */
export async function refreshAfterSecretChange(deps: LifecycleDeps, changes: readonly SecretChange[]): Promise<number> {
  const seen = new Set<string>()
  let refreshed = 0
  for (const change of changes) {
    for (const row of await sandboxesForSecretOwner(deps.db, change)) {
      if (seen.has(row.id)) {
        continue
      }
      seen.add(row.id)
      try {
        if (await refreshSandboxEnv(deps, row)) {
          refreshed++
        }
      } catch {
        console.log(JSON.stringify({ event: 'session_env_refresh_failed', sandboxId: row.id }))
      }
    }
  }
  return refreshed
}
