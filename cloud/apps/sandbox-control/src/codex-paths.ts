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
