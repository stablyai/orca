import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { readCallOptionKeys } from './call-site-option-keys'

/**
 * Locate every `new WebSocketServer(...)` in the tree and say, for each, whether
 * it pins a bind address.
 *
 * `ws` accepts `{ port }` alone and silently binds the wildcard address, so a
 * server the caller then dials on 127.0.0.1 sits at a port a foreign loopback
 * listener can also hold -- and the more specific listener wins the connection,
 * answering in that server's place.
 *
 * Anything unreadable is reported as `opaque` rather than skipped. A matcher
 * that silently exempts the shapes it fails to parse is worse than no matcher,
 * because it reads as coverage.
 */

export type BindSite = { path: string; line: number }
export type OpaqueSite = BindSite & { reason: string }

export type WebSocketServerBindScan = {
  filesScanned: number
  /** Every construction recognized, however it was then classified. */
  constructions: number
  /** Binds a port with no `host`: reachable at an address the dialer never named. */
  wildcardBound: BindSite[]
  /** Shape that could not be read; never treated as safe. */
  opaque: OpaqueSite[]
  /** Binds a port and pins `host`. */
  loopbackBound: BindSite[]
  /** No `port`: attaches to a server that owns the bind itself. */
  attached: BindSite[]
}

const IGNORED_DIRECTORIES = new Set([
  'node_modules',
  'dist',
  'out',
  'build',
  '.git',
  '__fixtures__',
  'coverage',
  // Full snapshots of older releases; their bind sites are not this tree's to fix.
  '.cross-version-checkouts'
])
const SCANNED_EXTENSIONS = /\.(?:ts|tsx|mts|cts)$/
const SCANNED_ROOTS = ['src', 'mobile', 'config', 'tests']
const WS_IMPORT_HINT = /from\s*['"]ws['"]/

function collectSourceFiles(root: string, found: string[] = []): string[] {
  let entries: ReturnType<typeof readdirSync<{ withFileTypes: true }>>
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch {
    return found
  }
  for (const entry of entries) {
    if (IGNORED_DIRECTORIES.has(entry.name)) {
      continue
    }
    const full = join(root, entry.name)
    if (entry.isDirectory()) {
      collectSourceFiles(full, found)
    } else if (SCANNED_EXTENSIONS.test(entry.name)) {
      found.push(full)
    }
  }
  return found
}

/** Local names bound to ws's server class, following `as` aliases and namespace imports. */
function webSocketServerNames(text: string): { direct: Set<string>; namespaces: Set<string> } {
  const direct = new Set<string>()
  const namespaces = new Set<string>()
  // One statement at a time: a pattern reaching for `from 'ws'` would swallow
  // every import above it and lose the specifier names in the blob.
  for (const match of text.matchAll(/\bimport\b([\s\S]*?)\bfrom\s*(['"])([^'"]+)\2/g)) {
    if (match[3] !== 'ws') {
      continue
    }
    const clause = match[1]
    if (/^\s*type\b/.test(clause)) {
      continue
    }
    const namespace = clause.match(/\*\s+as\s+([A-Za-z_$][\w$]*)/)
    if (namespace) {
      namespaces.add(namespace[1])
    }
    const named = clause.match(/\{([\s\S]*)\}/)
    if (!named) {
      continue
    }
    for (const specifier of named[1].split(',')) {
      const trimmed = specifier.trim()
      if (!trimmed || /^type\s/.test(trimmed)) {
        continue
      }
      const parts = trimmed.split(/\s+as\s+/)
      // `Server` is ws's own alias for WebSocketServer.
      if (parts[0].trim() === 'WebSocketServer' || parts[0].trim() === 'Server') {
        direct.add((parts[1] ?? parts[0]).trim())
      }
    }
  }
  return { direct, namespaces }
}

function classify(
  scan: WebSocketServerBindScan,
  site: BindSite,
  text: string,
  paren: number
): void {
  const options = readCallOptionKeys(text, paren)
  if (!options.readable) {
    scan.opaque.push({ ...site, reason: options.reason })
    return
  }
  if (!options.keys.includes('port')) {
    scan.attached.push(site)
    return
  }
  if (!options.keys.includes('host')) {
    scan.wildcardBound.push(site)
    return
  }
  scan.loopbackBound.push(site)
}

export function scanWebSocketServerBinds(repoRoot: string): WebSocketServerBindScan {
  const files = SCANNED_ROOTS.flatMap((directory) => collectSourceFiles(join(repoRoot, directory)))
  const scan: WebSocketServerBindScan = {
    filesScanned: files.length,
    constructions: 0,
    wildcardBound: [],
    opaque: [],
    loopbackBound: [],
    attached: []
  }
  for (const file of files) {
    const text = readFileSync(file, 'utf8')
    // Filter on the import, not on the class name: `Server as Wss` never spells
    // WebSocketServer, and keying on that name silently skipped the whole alias.
    if (!WS_IMPORT_HINT.test(text)) {
      continue
    }
    const { direct, namespaces } = webSocketServerNames(text)
    if (!direct.size && !namespaces.size) {
      continue
    }
    const path = relative(repoRoot, file).split('\\').join('/')
    const patterns = [
      ...[...direct].map((name) => new RegExp(`\\bnew\\s+${name}\\s*\\(`, 'g')),
      ...[...namespaces].map(
        (name) => new RegExp(`\\bnew\\s+${name}\\.(?:WebSocketServer|Server)\\s*\\(`, 'g')
      )
    ]
    for (const pattern of patterns) {
      for (const match of text.matchAll(pattern)) {
        scan.constructions++
        const line = text.slice(0, match.index).split('\n').length
        classify(scan, { path, line }, text, match.index + match[0].length - 1)
      }
    }
  }
  return scan
}

export function formatSites(sites: readonly BindSite[]): string[] {
  return sites.map((site) => `${site.path}:${site.line}`)
}
