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

export type ProviderEnv = { env: Record<string, string>; scopes: Record<string, string> }

/** Real values (presets derived) and their scopes, for the egress proxy's swap. Never sent to the VM with placeholders on. */
export async function resolvedProviderEnv(
  db: D1Database,
  keyring: Keyring,
  row: Pick<SandboxRow, 'id' | 'account_id' | 'user_id' | 'repo_url'>
): Promise<ProviderEnv> {
  const { env: stored, scopes } = await resolveSandboxSecrets(db, keyring, row)
  const env = deriveProviderEnv(stored)
  return { env, scopes: deriveProviderScopes(stored, env, scopes) }
}

// Decrypted model keys for the egress proxy, per sandbox session, for a minute: one D1 read and a
// decrypt per session-minute instead of per model request. Isolate memory only; a secret edit
// drops the sandbox's entry (in this isolate) so a rotated or deleted key stops being sent.
const PROVIDER_ENV_CACHE_MS = 60_000
const providerEnvCache = new Map<string, { at: number; value: Promise<ProviderEnv> }>()

export function cachedProviderEnv(db: D1Database, keyring: Keyring, row: SandboxRow, now: number): Promise<ProviderEnv> {
  const key = `${row.id}:${row.session_id ?? ''}`
  const hit = providerEnvCache.get(key)
  if (hit && now - hit.at < PROVIDER_ENV_CACHE_MS) {
    return hit.value
  }
  for (const [cached, entry] of providerEnvCache) {
    if (now - entry.at >= PROVIDER_ENV_CACHE_MS) {
      providerEnvCache.delete(cached)
    }
  }
  const value = resolvedProviderEnv(db, keyring, row)
  providerEnvCache.set(key, { at: now, value })
  value.catch(() => providerEnvCache.delete(key))
  return value
}

export function forgetProviderEnv(sandboxId: string): void {
  for (const key of providerEnvCache.keys()) {
    if (key.startsWith(`${sandboxId}:`)) {
      providerEnvCache.delete(key)
    }
  }
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
  const swap =
    !deps.secrets.egressPlaceholdersOff?.has(row.account_id) &&
    (placeholders === true || (placeholders instanceof Set && placeholders.has(row.account_id)))
  if (!swap || !deps.config.egressProxyUrl) {
    return { env, egressSecretHosts: null, egressAllowHosts }
  }
  const swapped = applySecretPlaceholders(row, env, scopes)
  return { env: swapped.env, egressSecretHosts: encodeEgressSecretHosts(swapped.targets), egressAllowHosts }
}

/** Provider hosts from the session's secrets plus the workspace's declared tool hosts (MCP). */
export function egressAllowHosts(row: Pick<SandboxRow, 'egress_allow_hosts'> & Partial<Pick<SandboxRow, 'egress_user_hosts'>>): string[] {
  return [...(row.egress_allow_hosts ?? '').split(','), ...(row.egress_user_hosts ?? '').split(',')].filter(Boolean)
}
