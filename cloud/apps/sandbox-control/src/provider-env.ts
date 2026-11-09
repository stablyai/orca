// Model-provider settings carried as secrets: presets (Vercel AI Gateway), custom Anthropic- or
// OpenAI-compatible base URLs, and which host each model credential is meant for. Pure functions:
// the session env, the egress allowlist and the placeholder swap all derive from the same answer.

export const AI_GATEWAY_HOST = 'ai-gateway.vercel.sh'
const AI_GATEWAY_ANTHROPIC_BASE_URL = `https://${AI_GATEWAY_HOST}`
const AI_GATEWAY_OPENAI_BASE_URL = `https://${AI_GATEWAY_HOST}/v1`

export const BASE_URL_NAMES: ReadonlySet<string> = new Set(['ANTHROPIC_BASE_URL', 'OPENAI_BASE_URL'])

const DEFAULT_HOSTS = { anthropic: 'api.anthropic.com', openai: 'api.openai.com' } as const
const HOST = /^([a-z0-9-]+\.)+[a-z]{2,63}$/
const PRIVATE_SUFFIXES = ['.local', '.localhost', '.internal', '.lan', '.home', '.corp', '.intranet']

/** Public https host of a base URL, or null when it is not one the VM may be routed to. */
export function baseUrlHost(value: string): string | null {
  let url: URL
  try {
    url = new URL(value.trim())
  } catch {
    return null
  }
  const host = url.hostname.toLowerCase()
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    (url.port !== '' && url.port !== '443') ||
    url.search ||
    url.hash ||
    !HOST.test(host) ||
    PRIVATE_SUFFIXES.some((suffix) => host.endsWith(suffix))
  ) {
    return null
  }
  return host
}

/**
 * Fills in what a preset implies, never overriding what the user set. An AI Gateway key alone
 * makes Claude Code and Codex both use the gateway; a provider pair the user configured stays put.
 */
export function deriveProviderEnv(env: Record<string, string>): Record<string, string> {
  const next = { ...env }
  const gateway = next.AI_GATEWAY_API_KEY
  if (gateway) {
    if (!next.ANTHROPIC_BASE_URL && !next.ANTHROPIC_API_KEY && !next.ANTHROPIC_AUTH_TOKEN) {
      next.ANTHROPIC_BASE_URL = AI_GATEWAY_ANTHROPIC_BASE_URL
      next.ANTHROPIC_AUTH_TOKEN = gateway
    }
    if (!next.OPENAI_BASE_URL && !next.OPENAI_API_KEY) {
      next.OPENAI_BASE_URL = AI_GATEWAY_OPENAI_BASE_URL
      next.OPENAI_API_KEY = gateway
    }
  }
  return next
}

export type CredentialTarget = {
  /** Env var holding the credential. */
  secret: string
  host: string
  /** Lowercase header name -> how the client sends the key in it. */
  headers: Record<string, (value: string) => string>
}

const bearer = (value: string) => `Bearer ${value}`
const raw = (value: string) => value

function hostFor(env: Record<string, string>, baseName: string, fallback: string): string | null {
  const base = env[baseName]
  return base ? baseUrlHost(base) : fallback
}

/**
 * Where each model credential in `env` is used, so the egress proxy can swap it in on that host
 * only. Clients differ: Claude Code sends ANTHROPIC_API_KEY as x-api-key and ANTHROPIC_AUTH_TOKEN as
 * a Bearer token; OpenAI clients send Bearer.
 */
export function credentialTargets(env: Record<string, string>): CredentialTarget[] {
  const targets: CredentialTarget[] = []
  const anthropicHost = hostFor(env, 'ANTHROPIC_BASE_URL', DEFAULT_HOSTS.anthropic)
  if (anthropicHost && env.ANTHROPIC_API_KEY) {
    targets.push({ secret: 'ANTHROPIC_API_KEY', host: anthropicHost, headers: { 'x-api-key': raw, authorization: bearer } })
  }
  if (anthropicHost && env.ANTHROPIC_AUTH_TOKEN) {
    targets.push({ secret: 'ANTHROPIC_AUTH_TOKEN', host: anthropicHost, headers: { authorization: bearer, 'x-api-key': raw } })
  }
  if (env.AI_GATEWAY_API_KEY) {
    // AI SDK clients read the gateway key directly.
    targets.push({ secret: 'AI_GATEWAY_API_KEY', host: AI_GATEWAY_HOST, headers: { authorization: bearer, 'x-api-key': raw } })
  }
  const openaiHost = hostFor(env, 'OPENAI_BASE_URL', DEFAULT_HOSTS.openai)
  if (openaiHost && env.OPENAI_API_KEY) {
    targets.push({ secret: 'OPENAI_API_KEY', host: openaiHost, headers: { authorization: bearer } })
  }
  return targets
}

/** Custom provider hosts the session must be able to reach (beyond the default allowlist). */
export function providerHosts(env: Record<string, string>): string[] {
  const hosts = new Set<string>()
  for (const name of BASE_URL_NAMES) {
    const host = env[name] ? baseUrlHost(env[name]) : null
    if (host) {
      hosts.add(host)
    }
  }
  return [...hosts].sort()
}
