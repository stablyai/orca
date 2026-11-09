// Phase-2 model API keys: the VM's env carries a placeholder, and the egress proxy swaps in the real
// key only on the provider's own API host. Node clients (Claude Code, Codex) hang under Vercel
// transform rules, so these hosts always take the forwardURL path through /v1/egress/proxy, the
// same path api.github.com uses. Placeholders are not secrets: the proxy authenticates the
// sandbox by Vercel's OIDC token, the placeholder only marks which header to swap.
import type { SandboxRow } from './store'

export type SecretEgressHost = {
  host: string
  /** Secret whose value is swapped in. */
  secret: string
  slug: string
  /** Header shapes the provider's clients send the key in, keyed by lowercase header name. */
  headers: Record<string, (value: string) => string>
}

export const SECRET_EGRESS_HOSTS: readonly SecretEgressHost[] = [
  {
    host: 'api.anthropic.com',
    secret: 'ANTHROPIC_API_KEY',
    slug: 'anthropic',
    headers: { 'x-api-key': (value) => value, authorization: (value) => `Bearer ${value}` }
  },
  {
    host: 'api.openai.com',
    secret: 'OPENAI_API_KEY',
    slug: 'openai',
    headers: { authorization: (value) => `Bearer ${value}` }
  }
]

export function secretPlaceholder(row: Pick<SandboxRow, 'id'>, slug: string): string {
  return `orca-ph-${slug}-${row.id}`
}

/** Hosts recorded on the row at boot as placeholder-routed for this session. */
export function egressSecretHosts(row: Pick<SandboxRow, 'egress_secret_hosts'>): SecretEgressHost[] {
  const hosts = new Set((row.egress_secret_hosts ?? '').split(',').filter(Boolean))
  return SECRET_EGRESS_HOSTS.filter((entry) => hosts.has(entry.host))
}

/**
 * Replaces model API keys with placeholders in a session's env. Returns the hosts the policy and
 * proxy must now route (and deny without the placeholder).
 */
export function applySecretPlaceholders(
  row: Pick<SandboxRow, 'id'>,
  env: Record<string, string>
): { env: Record<string, string>; hosts: string[] } {
  const next = { ...env }
  const hosts: string[] = []
  for (const entry of SECRET_EGRESS_HOSTS) {
    if (next[entry.secret]) {
      next[entry.secret] = secretPlaceholder(row, entry.slug)
      hosts.push(entry.host)
    }
  }
  return { env: next, hosts }
}
