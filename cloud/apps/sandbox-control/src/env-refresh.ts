// Secret edits reach running sandboxes without a restart or image rebuild: the control plane
// re-resolves the session env and hands it to `orca-sandbox-env` in the VM, which replaces the
// memory-only env file new shells and agent launches read. Processes already running keep the
// values they started with. Egress routes and the allowlist follow the new env first, so a new
// model key is reachable before any shell can see its placeholder.
import type { CredentialChange } from './credential-outbox'
import { applySandboxPolicy, syncMemberGit, firewallClasses, type LifecycleDeps } from './lifecycle'
import { ProviderError } from './sandbox-provider'
import { refreshSessionEnv } from './sandbox-vm-commands'
import { normalizeRepo, type SecretChange } from './secrets'
import { forgetProviderEnv, sessionSecretEnv } from './session-env'
import { transition, type SandboxRow } from './store'
import { secretLog } from './secret-log'

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

/**
 * A just-booted session whose env changed while it booted: a secret saved meanwhile (the build sheet asks
 * for missing ones) missed the boot's env, and that change's refresh skipped a sandbox not yet running.
 */
export async function envChangedSinceBoot(deps: LifecycleDeps, row: SandboxRow, bootEnv: Record<string, string>): Promise<boolean> {
  if (row.status !== 'running' || !deps.secrets) {
    return false
  }
  const { env } = await sessionSecretEnv(deps, row)
  const same = Object.keys(env).length === Object.keys(bootEnv).length && Object.entries(env).every(([k, v]) => bootEnv[k] === v)
  if (!same) {
    secretLog('session_env_changed_during_boot', { sandboxId: row.id })
  }
  return !same
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
    const applied = await applySandboxPolicy(deps, current, 'env_refresh', { sessionId: row.session_id })
    if (applied.gitExpiresAt !== null) {
      current = (await transition(deps.db, current, { github_token_expires_at: applied.gitExpiresAt }, deps.now())) ?? current
    }
  } else if (firewallClasses(deps, current).size > 0) {
    // Firewall mode (design §7.3): the firewall holds the values themselves, so any env change (a key edited
    // in place, a share, an owner change) must reach it even when the routes stayed the same.
    await applySandboxPolicy(deps, current, 'env_refresh', { sessionId: row.session_id })
  }
  try {
    const applied = await refreshSessionEnv(deps.provider, current.session_id!, secrets.env, generation)
    // Counts only.
    secretLog('session_env_refreshed', { sandboxId: row.id, applied, names: Object.keys(secrets.env).length })
    return applied
  } catch (error) {
    if (error instanceof ProviderError) {
      secretLog('session_env_refresh_failed', { sandboxId: row.id, code: error.code })
      return false
    }
    throw error
  }
}

/** Why a credential push re-applies the policy (design §7): the narrowing ones are in NARROWING_POLICY_REASONS. */
export type PolicyReason = 'refresh' | 'account_revoked' | 'account_signed_out' | 'credential_deleted'

/** The reason for a credential change, from its current state (the outbox records only that it changed). */
async function reasonFor(deps: LifecycleDeps, change: CredentialChange): Promise<PolicyReason> {
  if (change.kind === 'account') {
    const row = await deps.db
      .prepare('SELECT state, expires_at FROM agent_credentials WHERE user_id = ? AND agent = ?')
      .bind(change.userId, change.agent)
      .first<{ state: string; expires_at: number | null }>()
    if (!row) {
      return 'credential_deleted'
    }
    if (row.state === 'revoked') {
      return 'account_revoked'
    }
    return row.expires_at !== null && row.expires_at <= deps.now() ? 'account_signed_out' : 'refresh'
  }
  const row = await deps.db
    .prepare('SELECT access_expires_at, last_error FROM github_user_tokens WHERE account_id = ? AND user_id = ?')
    .bind(change.accountId, change.userId)
    .first<{ access_expires_at: number | null; last_error: string | null }>()
  const dead = !row || (row.access_expires_at !== null && row.access_expires_at <= deps.now()) || ['bad_refresh_token', 'refresh_expired', 'no_refresh_token'].includes(row.last_error ?? '')
  return dead ? 'credential_deleted' : 'refresh'
}

/**
 * EGRESS-REFRESH push: a credential this sandbox carries changed (refreshed, expired, revoked, removed). An
 * account sign-in also changes the session env (placeholders come and go), so that is refreshed first; the
 * policy is then rewritten whole. False when the sandbox is no longer running (nothing to push).
 */
export async function pushCredentialToSandbox(deps: LifecycleDeps, sandboxId: string, change: CredentialChange): Promise<boolean> {
  const row = await deps.db.prepare('SELECT * FROM sandboxes WHERE id = ?').bind(sandboxId).first<SandboxRow>()
  if (!row || row.status !== 'running' || !row.session_id) {
    return false
  }
  if (change.kind === 'account') {
    await refreshSandboxEnv(deps, row)
  }
  const current = (await deps.db.prepare('SELECT * FROM sandboxes WHERE id = ?').bind(sandboxId).first<SandboxRow>()) ?? row
  const applied = await applySandboxPolicy(deps, current, await reasonFor(deps, change), { sessionId: current.session_id ?? row.session_id })
  if (change.kind !== 'account' && current.session_id) {
    // GH-AS-MEMBER: a member who connected (or disconnected) GitHub mid-session gets (or loses) their identity in
    // the running VM now, not on its next boot.
    await syncMemberGit(deps, current, current.session_id)
  }
  if (applied.gitExpiresAt !== null) {
    await transition(deps.db, current, { github_token_expires_at: applied.gitExpiresAt }, deps.now())
  }
  return true
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
        secretLog('session_env_refresh_failed', { sandboxId: row.id })
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(REFRESH_CONCURRENCY, queue.length) }, worker))
  return refreshed
}
