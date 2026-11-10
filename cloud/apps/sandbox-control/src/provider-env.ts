// Model-provider settings carried as secrets: presets (Vercel AI Gateway), custom Anthropic-,
// OpenAI- or Copilot-BYOK base URLs, and which host each model credential is meant for. Pure functions:
// the session env, the egress allowlist and the placeholder swap all derive from the same answer.

export const AI_GATEWAY_HOST = 'ai-gateway.vercel.sh'
const AI_GATEWAY_ANTHROPIC_BASE_URL = `https://${AI_GATEWAY_HOST}`
const AI_GATEWAY_OPENAI_BASE_URL = `https://${AI_GATEWAY_HOST}/v1`

export const GEMINI_HOST = 'generativelanguage.googleapis.com'
export const CURSOR_API_HOST = 'api2.cursor.sh'

export const BASE_URL_NAMES: ReadonlySet<string> = new Set(['ANTHROPIC_BASE_URL', 'OPENAI_BASE_URL', 'COPILOT_PROVIDER_BASE_URL'])
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

/** Provenance for derived names: they inherit the scope of the preset key that produced them. */
export function deriveProviderScopes(
  stored: Record<string, string>,
  derived: Record<string, string>,
  scopes: ValueScopes
): Record<string, string> {
  const next: Record<string, string> = { ...scopes }
  for (const name of Object.keys(derived)) {
    if (!(name in stored) && scopes.AI_GATEWAY_API_KEY) {
      next[name] = scopes.AI_GATEWAY_API_KEY
    }
  }
  return next
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
} & CredentialPolicy

export type CredentialPolicy = {
  /** Only these requests may carry the key (exact method, path up to an optional query). Absent: any. */
  paths?: readonly { method: string; path: string }[]
  /**
   * The host stays reachable without the placeholder. Cursor trades the key for a short-lived access
   * token and sends that on every later call, so a 403 for unclaimed requests would break it.
   */
  allowUnclaimed?: true
  /**
   * The provider's reply must be a JSON object and only these top-level fields reach the VM (no
   * headers that set state either); anything else is refused.
   */
  keepResponseFields?: readonly string[]
}

const bearer = (value: string) => `Bearer ${value}`
const raw = (value: string) => value

/** Where each value came from; names absent here (derived by a preset) carry their source's host. */
export type ValueScopes = Readonly<Record<string, string>>

type CredentialSpec = CredentialPolicy & {
  secret: string
  /** Env var that may point this key at a custom host (honoured only from the key's own scope). */
  baseUrl?: string
  /** Host without a base URL; null: the key is only routed together with its base URL. */
  defaultHost: string | null
  headers: Record<string, (value: string) => string>
}

/**
 * Every model credential the egress proxy swaps, and how its clients send it. Claude Code sends
 * ANTHROPIC_API_KEY as x-api-key and ANTHROPIC_AUTH_TOKEN as Bearer; OpenAI clients, OpenCode's AI
 * Gateway provider and Copilot's BYOK provider send Bearer; Gemini CLI and Google AI SDK clients send
 * x-goog-api-key; cursor-agent sends CURSOR_API_KEY once, to exchange it for an access token.
 */
const CREDENTIALS: readonly CredentialSpec[] = [
  {
    secret: 'ANTHROPIC_API_KEY',
    baseUrl: 'ANTHROPIC_BASE_URL',
    defaultHost: 'api.anthropic.com',
    headers: { 'x-api-key': raw, authorization: bearer }
  },
  {
    secret: 'ANTHROPIC_AUTH_TOKEN',
    baseUrl: 'ANTHROPIC_BASE_URL',
    defaultHost: 'api.anthropic.com',
    headers: { authorization: bearer, 'x-api-key': raw }
  },
  // AI SDK clients (OpenCode's `vercel/...` models) read the gateway key directly.
  { secret: 'AI_GATEWAY_API_KEY', defaultHost: AI_GATEWAY_HOST, headers: { authorization: bearer, 'x-api-key': raw } },
  { secret: 'OPENAI_API_KEY', baseUrl: 'OPENAI_BASE_URL', defaultHost: 'api.openai.com', headers: { authorization: bearer } },
  { secret: 'GEMINI_API_KEY', defaultHost: GEMINI_HOST, headers: { 'x-goog-api-key': raw } },
  { secret: 'GOOGLE_GENERATIVE_AI_API_KEY', defaultHost: GEMINI_HOST, headers: { 'x-goog-api-key': raw } },
  {
    secret: 'CURSOR_API_KEY',
    defaultHost: CURSOR_API_HOST,
    headers: { authorization: bearer },
    paths: [{ method: 'POST', path: '/auth/exchange_user_api_key' }],
    allowUnclaimed: true,
    // Only the access token: without a refresh token cursor-agent keeps the access token in memory
    // and exchanges the key again when it expires; with one it would persist a long-lived credential.
    keepResponseFields: ['accessToken']
  },
  {
    secret: 'COPILOT_PROVIDER_API_KEY',
    baseUrl: 'COPILOT_PROVIDER_BASE_URL',
    defaultHost: null,
    headers: { authorization: bearer, 'api-key': raw }
  },
  {
    secret: 'COPILOT_PROVIDER_BEARER_TOKEN',
    baseUrl: 'COPILOT_PROVIDER_BASE_URL',
    defaultHost: null,
    headers: { authorization: bearer }
  }
]

/** Every credential name the proxy can swap. */
export const SWAPPED_CREDENTIALS: readonly string[] = CREDENTIALS.map((spec) => spec.secret)

/** How a credential is sent and policed, independent of the session's host choice. */
export function credentialShape(secret: string): Omit<CredentialTarget, 'host'> | null {
  const spec = CREDENTIALS.find((candidate) => candidate.secret === secret)
  if (!spec) {
    return null
  }
  const { baseUrl: _baseUrl, defaultHost: _defaultHost, ...shape } = spec
  return shape
}

/**
 * A base URL only redirects a credential from the same scope: a member's personal base URL must
 * never route the org's shared key to a host the member picked (the proxy would hand it over).
 */
function hostFor(env: Record<string, string>, spec: CredentialSpec, scopes?: ValueScopes): string | null {
  const base = spec.baseUrl ? env[spec.baseUrl] : undefined
  if (!base || !spec.baseUrl) {
    return spec.defaultHost
  }
  if (scopes && scopes[spec.baseUrl] !== scopes[spec.secret]) {
    return spec.defaultHost
  }
  return baseUrlHost(base)
}

/** Where each model credential in `env` is used, so the egress proxy can swap it in on that host only. */
export function credentialTargets(env: Record<string, string>, scopes?: ValueScopes): CredentialTarget[] {
  const targets: CredentialTarget[] = []
  for (const spec of CREDENTIALS) {
    const host = env[spec.secret] ? hostFor(env, spec, scopes) : null
    const shape = host ? credentialShape(spec.secret) : null
    if (host && shape) {
      targets.push({ ...shape, host })
    }
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
