import { posix } from 'node:path'

function normalizeIconHrefPath(href: string): { path: string; rootRelative: boolean } | null {
  const trimmed = href.trim()
  if (!trimmed || trimmed.startsWith('//') || /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(trimmed)) {
    return null
  }

  const rootRelative = trimmed.startsWith('/')
  const pathOnly = (trimmed.split(/[?#]/)[0] ?? '').replace(/^\/+/, '').replace(/\\/g, '/')
  const parts = pathOnly.split('/').filter((part) => part && part !== '.')
  // Why: declared icon hrefs are repo content. Never let a best-effort icon
  // probe resolve outside the worktree through `../` path segments.
  if (parts.length === 0 || parts.some((part) => part === '..')) {
    return null
  }
  return { path: parts.join('/'), rootRelative }
}

export function iconHrefCandidates(href: string, sourceFile: string): string[] {
  const clean = normalizeIconHrefPath(href)
  if (!clean) {
    return []
  }

  const candidates = new Set<string>()
  if (!clean.rootRelative) {
    const sourceDirectory = posix.dirname(sourceFile)
    if (sourceDirectory && sourceDirectory !== '.') {
      // Why: relative hrefs in nested route/root files resolve next to that
      // source file, not from the repository root.
      candidates.add(posix.join(sourceDirectory, clean.path))
    }
  }
  candidates.add(`public/${clean.path}`)
  candidates.add(clean.path)
  return [...candidates]
}
