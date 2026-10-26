// Keep this parser independent of desktop renderer imports for the mobile bundle.
const GH_ITEM_PATH_RE = /^\/([^/]+)\/([^/]+)\/(issues|pull)\/(\d+)(?:\/.*)?$/i

// Only GitHub hosts may populate the worktree’s linkedPR field.
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
