// What one sandbox session's agents see: the resolved secret store (precedence applied), provider
// presets filled in, and with egress placeholders on, model keys swapped for placeholders. The same
// answer drives the egress allowlist and the proxy's credential routes, at boot and on refresh.
import type { LifecycleDeps } from './lifecycle'
import { agentModesFor, withoutSignInCredentials, type AgentMode } from './agent-sources'
import { accountProvider } from './account-providers'
import type { CredentialAgent } from './agent-credential-names'
import { deriveProviderEnv, deriveProviderScopes, providerHosts } from './provider-env'
import { applySecretPlaceholders, encodeAccountRoute, encodeEgressSecretHosts } from './secret-egress'
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
  row: Pick<SandboxRow, 'id' | 'account_id' | 'user_id' | 'repo_url' | 'visibility'>
): Promise<ProviderEnv> {
  const { env: stored, scopes } = await resolveSandboxSecrets(db, keyring, row)
  // The proxy only needs the keys; dropping those of agents not on 'keep' happens at request time
  // through the row's recorded routes (an 'account' agent has no key route left).
  const env = deriveProviderEnv(stored)
  return { env, scopes: deriveProviderScopes(stored, env, scopes) }
}

// Decrypted model keys for the egress proxy, per sandbox session, for a minute: one D1 read and a
// decrypt per session-minute instead of per model request. Isolate memory only; a secret edit
// drops the sandbox's entry (in this isolate) so a rotated or deleted key stops being sent.
const PROVIDER_ENV_CACHE_MS = 60_000
const providerEnvCache = new Map<string, { at: number; value: Promise<ProviderEnv> }>()

export function cachedProviderEnv(db: D1Database, keyring: Keyring, row: SandboxRow, now: number): Promise<ProviderEnv> {
  // Visibility is part of the key: sharing a workspace stops its owner's personal keys at once (SEC-5).
  const key = `${row.id}:${row.session_id ?? ''}:${row.visibility}`
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

function egressSwapOn(deps: Pick<LifecycleDeps, 'secrets' | 'config'>, row: Pick<SandboxRow, 'account_id'>): boolean {
  const placeholders = deps.secrets?.egressPlaceholders
  return (
    !deps.secrets?.egressPlaceholdersOff?.has(row.account_id) &&
    (placeholders === true || (placeholders instanceof Set && placeholders.has(row.account_id))) &&
    Boolean(deps.config.egressProxyUrl)
  )
}

export type { AgentMode }

export async function sessionSecretEnv(
  deps: Pick<LifecycleDeps, 'db' | 'secrets' | 'config'>,
  row: SandboxRow
): Promise<SessionSecrets> {
  if (!deps.secrets) {
    return EMPTY
  }
  const { env: stored, scopes: storedScopes, skipped } = await resolveSandboxSecrets(deps.db, deps.secrets.keyring, row)
  const swap = egressSwapOn(deps, row)
  const derived = deriveProviderEnv(stored)
  // D10: per agent, the owner's account (placeholder), the kill-switch fallback, or the keys.
  const modes = await agentModesFor(deps.db, row, derived, {
    providerEnabled: deps.secrets.accountProviders ?? { claude: false, codex: false },
    accountsUsable: swap,
    now: Date.now(),
    // Usable means decryptable now, not just stored: a token we can't open must not hold the session in account mode.
    readable: async (agent) => {
      const provider = accountProvider(agent)
      return provider ? (await provider.credential(deps.db, deps.secrets!.keyring, row.user_id, Date.now())) !== null : false
    }
  })
  const dropped = new Set((Object.keys(modes) as CredentialAgent[]).filter((agent) => modes[agent] !== 'keep'))
  const env = withoutSignInCredentials(derived, dropped)
  const scopes = deriveProviderScopes(stored, env, storedScopes)
  const egressAllowHosts = providerHosts(env).join(',') || null
  // Counts only.
  console.log(JSON.stringify({ event: 'session_secrets', sandboxId: row.id, injected: Object.keys(env).length, skipped }))
  if (!swap) {
    return { env, egressSecretHosts: null, egressAllowHosts }
  }
  const swapped = applySecretPlaceholders(row, env, scopes)
  const accountEnv: Record<string, string> = {}
  const accountRoutes: string[] = []
  for (const agent of Object.keys(modes) as CredentialAgent[]) {
    const provider = modes[agent] === 'account' ? accountProvider(agent) : undefined
    if (provider) {
      Object.assign(accountEnv, provider.sessionEnv(row))
      accountRoutes.push(...provider.hosts.map((host) => encodeAccountRoute(agent, row.user_id, host)))
    }
  }
  const secretHosts = [encodeEgressSecretHosts(swapped.targets), ...accountRoutes].filter(Boolean).join(',') || null
  return { env: { ...swapped.env, ...accountEnv }, egressSecretHosts: secretHosts, egressAllowHosts }
}

/** Provider hosts from the session's secrets plus the workspace's declared tool hosts (MCP). */
export function egressAllowHosts(row: Pick<SandboxRow, 'egress_allow_hosts'> & Partial<Pick<SandboxRow, 'egress_user_hosts'>>): string[] {
  return [...(row.egress_allow_hosts ?? '').split(','), ...(row.egress_user_hosts ?? '').split(',')].filter(Boolean)
}
