// Model API keys kept out of the VM: the session env carries a placeholder, and the egress proxy
// swaps in the real key only on the host that credential is for (api.anthropic.com,
// api.openai.com, ai-gateway.vercel.sh, generativelanguage.googleapis.com, api2.cursor.sh or a custom
// provider base URL). Node clients (Claude Code,
// Codex) hang under Vercel transform rules, so these hosts always take the forwardURL path through
// /v1/egress/proxy, the same path api.github.com uses. Placeholders are not secrets: the proxy
// authenticates the sandbox by Vercel's OIDC token, the placeholder only marks which header to swap.
import { SWAPPED_CREDENTIALS, credentialShape, credentialTargets, type CredentialTarget, type ValueScopes } from './provider-env'
import type { SandboxRow } from './store'

export type SecretEgressHost = CredentialTarget

/** Rows written before credentials were host-scoped stored bare hosts. */
const LEGACY_HOSTS: Record<string, string> = { 'api.anthropic.com': 'ANTHROPIC_API_KEY', 'api.openai.com': 'OPENAI_API_KEY' }

export function secretPlaceholder(row: Pick<SandboxRow, 'id'>, secret: string): string {
  return `orca-ph-${secret.toLowerCase().replaceAll('_', '-')}-${row.id}`
}

/** `SECRET@host` entries recorded on the row at boot (or refresh) as placeholder-routed. */
export function encodeEgressSecretHosts(targets: readonly CredentialTarget[]): string | null {
  return targets.map((target) => `${target.secret}@${target.host}`).join(',') || null
}

/** Credential routes recorded on the row for this session. */
export function egressSecretHosts(row: Pick<SandboxRow, 'egress_secret_hosts'>): SecretEgressHost[] {
  const recorded: Record<string, string> = {}
  for (const entry of (row.egress_secret_hosts ?? '').split(',').filter(Boolean)) {
    const at = entry.indexOf('@')
    const [secret, host] = at === -1 ? [LEGACY_HOSTS[entry], entry] : [entry.slice(0, at), entry.slice(at + 1)]
    if (secret && host) {
      recorded[secret] = host
    }
  }
  // Header shapes and policies come from the code, never from the row. The base URL value is only
  // used to pick the default-vs-custom host, and the recorded host is what was allowlisted at boot.
  return SWAPPED_CREDENTIALS.flatMap((secret) => {
    const host = recorded[secret]
    const shape = host ? credentialShape(secret) : null
    return host && shape ? [{ ...shape, host }] : []
  })
}

/**
 * Replaces model API keys with placeholders in a session's env. Returns the credential routes the
 * policy and proxy must now serve (and deny without the placeholder).
 */
export function applySecretPlaceholders(
  row: Pick<SandboxRow, 'id'>,
  env: Record<string, string>,
  scopes?: ValueScopes
): { env: Record<string, string>; targets: CredentialTarget[] } {
  const next = { ...env }
  const targets = credentialTargets(env, scopes)
  for (const target of targets) {
    next[target.secret] = secretPlaceholder(row, target.secret)
  }
  return { env: next, targets }
}
