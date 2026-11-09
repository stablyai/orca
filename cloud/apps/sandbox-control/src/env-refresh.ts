// Secret edits reach running sandboxes without a restart or image rebuild: the control plane
// re-resolves the session env and hands it to `orca-sandbox-env` in the VM, which replaces the
// memory-only env file new shells and agent launches read. Processes already running keep the
// values they started with. Egress routes and the allowlist follow the new env first, so a new
// model key is reachable before any shell can see its placeholder.
import { egressPolicy, refreshGitCredentials, type LifecycleDeps } from './lifecycle'
import { ProviderError } from './sandbox-provider'
import { refreshSessionEnv } from './sandbox-vm-commands'
import { normalizeRepo, type SecretChange } from './secrets'
import { forgetProviderEnv, sessionSecretEnv } from './session-env'
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
  // Ordered by when the env was resolved: a slower, older refresh never overwrites a newer one.
  const generation = deps.now()
  const secrets = await sessionSecretEnv(deps, row)
  forgetProviderEnv(row.id)
  let current = row
  if (secrets.egressSecretHosts !== row.egress_secret_hosts || secrets.egressAllowHosts !== row.egress_allow_hosts) {
    // Claim the row first: if a lifecycle transition won, that boot resolves the env itself and the
    // policy is left alone (never a policy that disagrees with the row).
    const next = await transition(
      deps.db,
      row,
      { egress_secret_hosts: secrets.egressSecretHosts, egress_allow_hosts: secrets.egressAllowHosts },
      deps.now()
    )
    if (!next) {
      return false
    }
    current = next
    // A policy write replaces the whole policy, so the git route is re-minted alongside.
    const git = await refreshGitCredentials(deps, current, row.session_id)
    if (!git) {
      await deps.provider.updateNetworkPolicy(row.session_id, egressPolicy(deps, current))
    } else {
      current = (await transition(deps.db, current, { github_token_expires_at: git.expiresAt }, deps.now())) ?? current
    }
  }
  try {
    const applied = await refreshSessionEnv(deps.provider, current.session_id!, secrets.env, generation)
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

const REFRESH_CONCURRENCY = 8

/** After a secret write: refresh every running session that reads that owner's secrets (8 at a time). */
export async function refreshAfterSecretChange(deps: LifecycleDeps, changes: readonly SecretChange[]): Promise<number> {
  const rows = new Map<string, SandboxRow>()
  for (const change of changes) {
    for (const row of await sandboxesForSecretOwner(deps.db, change)) {
      rows.set(row.id, row)
    }
  }
  const queue = [...rows.values()]
  let refreshed = 0
  const worker = async () => {
    for (let row = queue.shift(); row; row = queue.shift()) {
      try {
        if (await refreshSandboxEnv(deps, row)) {
          refreshed++
        }
      } catch {
        console.log(JSON.stringify({ event: 'session_env_refresh_failed', sandboxId: row.id }))
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(REFRESH_CONCURRENCY, queue.length) }, worker))
  return refreshed
}
