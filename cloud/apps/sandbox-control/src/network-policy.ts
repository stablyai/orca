// Fail-closed egress for Orca Cloud sandboxes (Vercel v2 record-form network policy).
// - No "*" entry unless a workspace opts into open egress: unlisted domains do not resolve.
// - Credential hosts end with a 403 rule, so only requests carrying our placeholder get through.
// - Hosts Node clients use are forwarded to our egress proxy instead of transformed: with a
//   transform rule Vercel's proxy answers HTTP/1.1 without content-length or transfer-encoding and
//   undici fetch hangs on the body (bake-off). curl/git and Go clients are unaffected.

type Matcher = { exact?: string; startsWith?: string }
export type NetworkPolicyRule =
  | {
      match?: { headers?: { key: Matcher; value: Matcher }[] }
      transform: { headers: Record<string, string> }[]
    }
  | { match?: { headers?: { key: Matcher; value: Matcher }[] }; forwardURL: string }
  | { response: { statusCode: number; body: string; contentType: string } }

export type NetworkPolicy = { allow: Record<string, NetworkPolicyRule[]> }

export const EGRESS_DENIED_BODY = 'orca-egress-denied'

/** Registries, git hosting and agent model/sign-in hosts a coding VM needs. */
export const DEFAULT_EGRESS_ALLOWLIST: readonly string[] = [
  'registry.npmjs.org',
  'registry.yarnpkg.com',
  'pypi.org',
  'files.pythonhosted.org',
  'crates.io',
  'index.crates.io',
  'static.crates.io',
  'proxy.golang.org',
  'sum.golang.org',
  'rubygems.org',
  'nodejs.org',
  'archive.ubuntu.com',
  'security.ubuntu.com',
  // Public clones/fetches work without a GitHub App install; a minted repo token adds the credential
  // route on top (placeholder in, real token out, everything else on that host 403s).
  'github.com',
  'codeload.github.com',
  'objects.githubusercontent.com',
  'raw.githubusercontent.com',
  // Agent CLIs reach several vendor hosts (API, sign-in, telemetry, updates); found live: platform.claude.com.
  'anthropic.com',
  'api.anthropic.com',
  '*.anthropic.com',
  'claude.ai',
  '*.claude.ai',
  'claude.com',
  '*.claude.com',
  'openai.com',
  'api.openai.com',
  '*.openai.com',
  'chatgpt.com',
  '*.chatgpt.com',
  'generativelanguage.googleapis.com',
  'oauth2.googleapis.com',
  'accounts.google.com',
  // Vercel AI Gateway: Anthropic/OpenAI-compatible endpoint teams point agents at (ANTHROPIC_BASE_URL).
  'ai-gateway.vercel.sh',
  '*.onorca.dev'
]

export type CredentialRoute = {
  host: string
  /** Header the VM sends with a placeholder value, matched exactly (one claim rule per value). */
  header: string
  placeholders: readonly string[]
} & (
  | { via: 'transform'; value: string }
  | { via: 'forward'; forwardURL: string }
)

export type EgressPolicyInput = {
  mode: 'allowlist' | 'open'
  allowlist?: readonly string[]
  credentials?: readonly CredentialRoute[]
}

const HOST = /^(\*\.)?([a-z0-9-]+\.)+[a-z]{2,63}$/

export function compileNetworkPolicy(input: EgressPolicyInput): NetworkPolicy {
  const allow: Record<string, NetworkPolicyRule[]> = {}
  for (const host of input.allowlist ?? DEFAULT_EGRESS_ALLOWLIST) {
    allow[checkedHost(host)] = []
  }
  for (const route of input.credentials ?? []) {
    const host = checkedHost(route.host)
    if (host.startsWith('*.')) {
      throw new Error('credential routes need an exact host')
    }
    const header = route.header.toLowerCase()
    const claims = route.placeholders.map((placeholder): NetworkPolicyRule => {
      const match = { headers: [{ key: { exact: header }, value: { exact: placeholder } }] }
      return route.via === 'transform'
        ? { match, transform: [{ headers: { [header]: route.value } }] }
        : { match, forwardURL: route.forwardURL }
    })
    const rules = allow[host]?.filter((rule) => !('response' in rule)) ?? []
    allow[host] = [...rules, ...claims, denyRule()]
  }
  if (input.mode === 'open') {
    allow['*'] = []
  }
  return { allow }
}

function denyRule(): NetworkPolicyRule {
  return { response: { statusCode: 403, body: EGRESS_DENIED_BODY, contentType: 'text/plain' } }
}

function checkedHost(host: string): string {
  const normalized = host.trim().toLowerCase()
  if (!HOST.test(normalized)) {
    throw new Error(`invalid egress host: ${host}`)
  }
  return normalized
}

/** Basic credential git sends when `http.<url>.extraheader` carries the placeholder token. */
export function gitBasicAuthorization(token: string): string {
  return `Basic ${btoa(`x-access-token:${token}`)}`
}
