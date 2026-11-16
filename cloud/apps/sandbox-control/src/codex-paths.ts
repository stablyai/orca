// The chatgpt.com paths Codex's login may be used on. Shared, unchanged, by the Worker's egress proxy
// (codex-credentials.ts) and the ChatGPT relay (cloud/apps/chatgpt-relay), which pins the same paths a
// second time. Erasable TypeScript only: the relay runs this file with Node's type stripping.

/**
 * The ChatGPT backend calls Codex makes with its login (seen live, Codex 0.166): the Codex API itself, its
 * plugin catalog and usage. Nothing else on chatgpt.com (conversations, memories, connectors) gets the token.
 */
const CODEX_PREFIXES = ['/backend-api/codex/']
const CODEX_EXACT_GETS = new Set([
  '/backend-api/ps/plugins/list',
  '/backend-api/ps/plugins/installed',
  '/backend-api/ps/plugins/suggested/codex',
  '/backend-api/plugins/featured',
  '/backend-api/plugins/export/curated',
  '/backend-api/wham/usage'
])

export function codexPathAllowed(method: string, path: string): boolean {
  const pathname = path.split('?')[0] ?? ''
  // Plain segments only: no encoded or dot segments that could walk out of an allowed prefix.
  if (!/^(\/[A-Za-z0-9_~-][A-Za-z0-9._~-]*)+\/?$/.test(pathname) || /(^|\/)\.\.?(\/|$)/.test(pathname)) {
    return false
  }
  if (CODEX_PREFIXES.some((prefix) => pathname.startsWith(prefix))) {
    return true
  }
  return method.toUpperCase() === 'GET' && CODEX_EXACT_GETS.has(pathname)
}


/**
 * The hot Codex calls whose token is swapped at the sandbox firewall itself (no Worker
 * hop). Exact paths only: the firewall compares the raw path, so a prefix could be walked out of with an
 * encoded dot segment (/backend-api/codex/%2e%2e/conversations, seen live) that the upstream then
 * normalises. Every other Codex call keeps the egress proxy, whose pinning (codexPathAllowed) rejects that.
 * Each entry must also pass codexPathAllowed (tested). The firewall matches the path without its query.
 */
export const CODEX_FIREWALL_PATHS: readonly { exact: string; methods: readonly string[] }[] = [
  { exact: '/backend-api/codex/responses', methods: ['POST'] },
  { exact: '/backend-api/codex/responses/compact', methods: ['POST'] },
  { exact: '/backend-api/codex/models', methods: ['GET'] },
  { exact: '/backend-api/wham/usage', methods: ['GET'] }
]

/**
 * Firewall mode (design §1): every Codex call is swapped at the firewall, so the catalog GETs join the hot
 * paths (still exact). Anything else Codex sends with the placeholder gets the 403: a new Codex endpoint is
 * added here once seen, never covered by a prefix.
 */
export const CODEX_FIREWALL_ALL_PATHS: readonly { exact: string; methods: readonly string[] }[] = [
  ...CODEX_FIREWALL_PATHS,
  ...[...CODEX_EXACT_GETS].filter((exact) => !CODEX_FIREWALL_PATHS.some((path) => path.exact === exact)).map((exact) => ({ exact, methods: ['GET'] }))
]
