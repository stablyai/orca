// What one sandbox session's agents see: the resolved secret store (precedence applied), provider
// presets filled in, and with egress placeholders on, model keys swapped for placeholders. The same
// answer drives the egress allowlist and the proxy's credential routes, at boot and on refresh.
import type { LifecycleDeps } from './lifecycle'
import { deriveProviderEnv, deriveProviderScopes, providerHosts } from './provider-env'
import { applySecretPlaceholders, encodeEgressSecretHosts } from './secret-egress'
import { resolveSandboxSecrets } from './secrets'
import type { Keyring } from './secrets-crypto'
import type { SandboxRow } from './store'

export type SessionSecrets = {
  env: Record<string, string>
  /** Row value for `egress_secret_hosts`. */
  egressSecretHosts: string | null
  /** Row value for `egress_allow_hosts`. */
  egressAllowHosts: string | null
}

const EMPTY: SessionSecrets = { env: {}, egressSecretHosts: null, egressAllowHosts: null }

/** Real values (presets derived), for the egress proxy's swap. Never sent to the VM with placeholders on. */
export async function resolvedProviderEnv(
  db: D1Database,
  keyring: Keyring,
  row: Pick<SandboxRow, 'id' | 'account_id' | 'user_id' | 'repo_url'>
): Promise<Record<string, string>> {
  return deriveProviderEnv((await resolveSandboxSecrets(db, keyring, row)).env)
}

export async function sessionSecretEnv(
  deps: Pick<LifecycleDeps, 'db' | 'secrets' | 'config'>,
  row: SandboxRow
): Promise<SessionSecrets> {
  if (!deps.secrets) {
    return EMPTY
  }
  const { env: stored, scopes: storedScopes, skipped } = await resolveSandboxSecrets(deps.db, deps.secrets.keyring, row)
  const env = deriveProviderEnv(stored)
  const scopes = deriveProviderScopes(stored, env, storedScopes)
  const egressAllowHosts = providerHosts(env).join(',') || null
  // Counts only.
  console.log(JSON.stringify({ event: 'session_secrets', sandboxId: row.id, injected: Object.keys(env).length, skipped }))
  const placeholders = deps.secrets.egressPlaceholders
  const swap = placeholders === true || (placeholders instanceof Set && placeholders.has(row.account_id))
  if (!swap || !deps.config.egressProxyUrl) {
    return { env, egressSecretHosts: null, egressAllowHosts }
  }
  const swapped = applySecretPlaceholders(row, env, scopes)
  return { env: swapped.env, egressSecretHosts: encodeEgressSecretHosts(swapped.targets), egressAllowHosts }
}

export function egressAllowHosts(row: Pick<SandboxRow, 'egress_allow_hosts'>): string[] {
  return (row.egress_allow_hosts ?? '').split(',').filter(Boolean)
}
