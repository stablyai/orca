// Egress for Orca Cloud sandboxes (Vercel v2 record-form network policy).
// - Workspace sandboxes default to the "open" preset: a "*" entry, so any host is reachable. The
//   "limited" preset is the fail-closed allowlist (no "*": unlisted domains do not resolve).
// - Either way, credential hosts carry our claim rules and end with a 403 rule, so only requests
//   carrying our placeholder get through there. Real tokens never enter the VM: the policy swaps
//   placeholders at egress (transform) or forwards them to our egress proxy (forwardURL).
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

/**
 * "Open in VS Code / Cursor" over `orca ssh`: the editor's Remote-SSH installs its server in the VM
 * and the server installs the user's remote extensions. Without these the editor falls back to
 * downloading on the desktop and copying over SSH (slower, and extensions still fail).
 */
export const EDITOR_REMOTE_SERVER_HOSTS: readonly string[] = [
  // VS Code: update.code.visualstudio.com redirects to the prss CDN; vscode-cdn serves web assets.
  'update.code.visualstudio.com',
  'vscode.download.prss.microsoft.com',
  '*.vscode-cdn.net',
  'marketplace.visualstudio.com',
  '*.gallery.vsassets.io',
  '*.gallerycdn.vsassets.io',
  '*.vscode-unpkg.net',
  // Cursor: its remote server builds (downloads.cursor.com, older builds from the blob) and its
  // extension marketplace, which redirects to Open VSX.
  'downloads.cursor.com',
  'cursor.blob.core.windows.net',
  'marketplace.cursorapi.com',
  'open-vsx.org',
  'openvsxorg.blob.core.windows.net'
]

/** Orca's own hosts when ORCA_PLATFORM_HOST_SUFFIXES is unset. */
export const DEFAULT_PLATFORM_HOST_SUFFIXES: readonly string[] = ['*.onorca.dev']

/** Registries, git hosting and agent model/sign-in hosts a coding VM needs (platform hosts excluded). */
const BASE_EGRESS_HOSTS: readonly string[] = [
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
  // Vertex AI express mode (GOOGLE_API_KEY with GOOGLE_GENAI_USE_VERTEXAI=true).
  'aiplatform.googleapis.com',
  // Gemini CLI signed in with Google: Code Assist API and the account lookup after OAuth.
  'cloudcode-pa.googleapis.com',
  'www.googleapis.com',
  // Cursor agent: API (api2), metrics (api3), direct bridge and sign-in pages.
  'api2.cursor.sh',
  '*.cursor.sh',
  'cursor.com',
  '*.cursor.com',
  // OpenCode: its model catalog. (opencode.ai is left off: its share API takes anonymous uploads.)
  'models.dev',
  // GitHub Copilot CLI: Copilot API (per plan: api.individual., api.business., ...).
  'api.githubcopilot.com',
  '*.githubcopilot.com'
]

const HOST = /^(\*\.)?([a-z0-9-]+\.)+[a-z]{2,63}$/

/** ORCA_PLATFORM_HOST_SUFFIXES names an entry no egress policy can hold; `invalid` quotes them (hosts, not secrets). */
export class PlatformHostSuffixesConfigError extends Error {
  constructor(readonly invalid: readonly string[]) {
    super(`ORCA_PLATFORM_HOST_SUFFIXES has invalid hosts: ${invalid.join(', ')} (expected e.g. *.onorca.dev)`)
    this.name = 'PlatformHostSuffixesConfigError'
  }
}

/**
 * Orca's platform hosts from ORCA_PLATFORM_HOST_SUFFIXES (comma list, e.g. `*.onorca.dev`). Unset, blank
 * or only commas: DEFAULT_PLATFORM_HOST_SUFFIXES. Throws PlatformHostSuffixesConfigError on a malformed
 * entry, naming it, instead of an opaque failure in each limited-mode policy compile.
 */
export function platformHostSuffixesFrom(platformHostSuffixes?: string): readonly string[] {
  const configured = (platformHostSuffixes ?? '').split(',').map((host) => host.trim().toLowerCase()).filter(Boolean)
  const invalid = configured.filter((host) => !HOST.test(host))
  if (invalid.length > 0) {
    throw new PlatformHostSuffixesConfigError(invalid)
  }
  return configured.length > 0 ? configured : DEFAULT_PLATFORM_HOST_SUFFIXES
}

/**
 * The base allowlist, or the config error when ORCA_PLATFORM_HOST_SUFFIXES is malformed. Only what
 * compiles an allowlist policy refuses on the error; reads, stops and the reconcile cron keep working.
 */
export function egressAllowlistSetting(platformHostSuffixes?: string): { allowlist?: readonly string[]; error?: PlatformHostSuffixesConfigError } {
  try {
    return { allowlist: egressAllowlistFor(platformHostSuffixes) }
  } catch (error) {
    if (error instanceof PlatformHostSuffixesConfigError) {
      return { error }
    }
    throw error
  }
}

/** The default allowlist with Orca's platform hosts (platformHostSuffixesFrom). */
export function egressAllowlistFor(platformHostSuffixes?: string): readonly string[] {
  const platform = platformHostSuffixesFrom(platformHostSuffixes)
  return [...new Set([...BASE_EGRESS_HOSTS, ...platform, ...EDITOR_REMOTE_SERVER_HOSTS])]
}

export const DEFAULT_EGRESS_ALLOWLIST: readonly string[] = egressAllowlistFor()

/**
 * Workspace sandbox egress presets. `open` (the default) reaches the whole internet, like Codespaces
 * or Devin; `limited` is the fail-closed allowlist above. Credential routes apply under both.
 */
export type EgressPreset = 'open' | 'limited'
export const DEFAULT_EGRESS_PRESET: EgressPreset = 'open'

/** Operator setting (SANDBOX_EGRESS_PRESET): unset means the default; a value we don't know fails closed. */
export function parseEgressPreset(value: string | undefined): EgressPreset {
  const preset = value?.trim().toLowerCase()
  if (!preset) {
    return DEFAULT_EGRESS_PRESET
  }
  return preset === 'open' ? 'open' : 'limited'
}

export type CredentialRoute = {
  host: string
  /** Header the VM sends with a placeholder value, matched exactly (one claim rule per value). */
  header: string
  placeholders: readonly string[]
  /** Requests without a placeholder still pass (the host is shared with the client's own tokens). */
  allowUnclaimed?: boolean
} & (
  | { via: 'transform'; value: string }
  | { via: 'forward'; forwardURL: string }
)

export type EgressPolicyInput = {
  mode: 'allowlist' | 'open'
  /** Hosts reachable under `allowlist` mode (default: DEFAULT_EGRESS_ALLOWLIST). Unused when open. */
  allowlist?: readonly string[]
  credentials?: readonly CredentialRoute[]
  /**
   * Default true: a credential host answers 403 to requests without our placeholder. Environment
   * builds (open egress anyway) turn it off so public repos still clone anonymously next to private ones.
   */
  denyUnclaimed?: boolean
}


export function compileNetworkPolicy(input: EgressPolicyInput): NetworkPolicy {
  const allow: Record<string, NetworkPolicyRule[]> = {}
  // Under "*" a bare host entry adds nothing, so open policies list only hosts that carry rules.
  for (const host of input.mode === 'open' ? [] : (input.allowlist ?? DEFAULT_EGRESS_ALLOWLIST)) {
    allow[checkedHost(host)] = []
  }
  const denied = new Set<string>()
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
    allow[host] = [...(allow[host] ?? []), ...claims]
    // One route that wants the deny is enough: a shared host fails closed.
    if (input.denyUnclaimed !== false && !route.allowUnclaimed) {
      denied.add(host)
    }
  }
  for (const host of denied) {
    allow[host] = [...(allow[host] ?? []), denyRule()]
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
