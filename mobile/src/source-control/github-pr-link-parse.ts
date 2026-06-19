// Parses a GitHub PR/issue reference from user input — a bare number, "#42", or a
// full GitHub URL — mirroring the desktop parseGitHubIssueOrPRNumber
// (src/renderer/src/lib/github-links.ts). Ported (not imported) so the mobile bundle
// stays free of renderer modules. Returns null for anything unparseable; guards
// number > 0 so the link flow never persists PR #0.
const GH_ITEM_PATH_RE = /^\/([^/]+)\/([^/]+)\/(issues|pull)\/(\d+)(?:\/.*)?$/i

// Why: this parser is GitHub-specific (the link flow writes the worktree's
// GitHub linkedPR key), so only github.com / its enterprise subdomains may parse —
// otherwise `https://example.com/o/r/pull/7` would be mistaken for a GitHub PR.
function isGitHubHost(hostname: string): boolean {
  const host = hostname.toLowerCase()
  return host === 'github.com' || host.endsWith('.github.com')
}

export function parseGitHubPrReference(input: string): number | null {
  const trimmed = input.trim()
  if (!trimmed) {
    return null
  }

  const numeric = trimmed.startsWith('#') ? trimmed.slice(1) : trimmed
  if (/^\d+$/.test(numeric)) {
    const n = Number.parseInt(numeric, 10)
    return n > 0 ? n : null
  }

  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return null
  }
  if (!isGitHubHost(url.hostname)) {
    return null
  }
  const match = GH_ITEM_PATH_RE.exec(url.pathname.replace(/\/+$/, ''))
  if (!match) {
    return null
  }
  const n = Number.parseInt(match[4], 10)
  return n > 0 ? n : null
}
