/**
 * A worktree reached through a symlink (`~/code` -> `/Volumes/…`, anything under
 * `/tmp` or `/var`) or spelled with different casing than disk on a
 * case-insensitive volume breaks recursive watching, differently per platform:
 *
 * - Linux: `@parcel/watcher` passes `IN_DONT_FOLLOW | IN_ONLYDIR` to
 *   `inotify_add_watch`, so a symlinked root fails outright with ENOTDIR
 *   ("Not a directory"). The watch never installs, and Orca caches the root in
 *   `unwatchableRoots`, so it is not retried for the rest of the session.
 * - macOS: FSEvents installs the watch but reports OS-canonical paths —
 *   symlinks resolved, each directory in its on-disk spelling — so events land
 *   outside the root the caller subscribed with.
 * - Windows: `GetFinalPathNameByHandle` behind `realpath` resolves junctions
 *   and substituted drives the same way.
 *
 * Both failures have the same visible symptom, because every consumer derives a
 * worktree-relative path from the subscribed root and silently drops whatever
 * falls outside it: the editor never reloads an agent's edit, the File Explorer
 * never refreshes, and Source Control never re-runs status.
 *
 * So hand the backend the resolved directory, which is watchable everywhere,
 * then map delivered paths back to the caller's spelling so the "event paths
 * live under worktreePath" contract holds on every platform.
 */
import { realpathSync } from 'node:fs'

export type WatcherEventPathRewriter = (eventPath: string) => string

const CASE_INSENSITIVE_PLATFORMS = new Set<NodeJS.Platform>(['darwin', 'win32'])

const identityWatcherEventPathRewriter: WatcherEventPathRewriter = (eventPath) => eventPath

function isWindowsStyleRoot(rootPath: string, platform: NodeJS.Platform): boolean {
  return (
    /^[A-Za-z]:/.test(rootPath) ||
    rootPath.startsWith('\\\\') ||
    (platform === 'win32' && rootPath.startsWith('//'))
  )
}

// Why: backslash is a legal POSIX filename character, so only Windows roots may
// treat it as a separator.
function splitRootSegments(value: string, windowsStyle: boolean): string[] {
  const parts = windowsStyle ? value.split(/[\\/]+/) : value.split('/')
  return parts.filter((part) => part.length > 0)
}

type RootPath = {
  value: string
  prefix: string
  separator: '/' | '\\'
}

function describeRootPath(value: string, windowsStyle: boolean): RootPath {
  const separator: '/' | '\\' = windowsStyle && !value.includes('/') ? '\\' : '/'
  return {
    value,
    prefix: value.endsWith(separator) ? value : `${value}${separator}`,
    separator
  }
}

function matchingSuffix(
  rootSegments: readonly string[],
  candidate: string,
  windowsStyle: boolean,
  foldSegment: (segment: string) => string
): string[] | null {
  const candidateSegments = splitRootSegments(candidate, windowsStyle)
  if (candidateSegments.length < rootSegments.length) {
    return null
  }
  const matches = rootSegments.every((rootSegment, index) => {
    const candidateSegment = candidateSegments[index]
    return candidateSegment !== undefined && foldSegment(candidateSegment) === rootSegment
  })
  return matches ? candidateSegments.slice(rootSegments.length) : null
}

export function createRootPathRewriter(
  requestedRoot: string,
  canonicalRoot: string,
  platform: NodeJS.Platform = process.platform
): WatcherEventPathRewriter {
  const windowsStyle = isWindowsStyleRoot(requestedRoot, platform)
  const requested = describeRootPath(requestedRoot, windowsStyle)
  const canonical = describeRootPath(canonicalRoot, windowsStyle)
  const canonicalSegments = splitRootSegments(canonicalRoot, windowsStyle)
  if (canonicalSegments.length === 0) {
    return identityWatcherEventPathRewriter
  }
  const caseInsensitive = CASE_INSENSITIVE_PLATFORMS.has(platform)
  // Why: fold per segment rather than over the whole path — NFC and case
  // folding both change length, so a folded-prefix length would slice the raw
  // event path mid-character and fabricate a path. Segment counts survive both.
  const foldSegment = (segment: string): string => {
    const normalized = segment.normalize('NFC')
    return caseInsensitive ? normalized.toLowerCase() : normalized
  }
  const foldedCanonicalSegments = canonicalSegments.map(foldSegment)

  return (eventPath) => {
    // Already spelled the way the renderer subscribed — the whole non-macOS world.
    if (eventPath === requested.value || eventPath.startsWith(requested.prefix)) {
      return eventPath
    }
    // A plain symlinked root differs only by prefix; splice it byte-exact so the
    // per-segment fold below is reached only for casing/Unicode differences.
    if (eventPath.startsWith(canonical.prefix)) {
      return `${requested.prefix}${eventPath.slice(canonical.prefix.length)}`
    }
    const suffix = matchingSuffix(foldedCanonicalSegments, eventPath, windowsStyle, foldSegment)
    if (suffix === null) {
      return eventPath
    }
    return suffix.length === 0
      ? requested.value
      : `${requested.prefix}${suffix.join(requested.separator)}`
  }
}

export type WatcherRootPaths = {
  /** Directory to hand the watcher backend — symlinks resolved. */
  watchRoot: string
  /** Maps a delivered event path back onto the caller's spelling. */
  rewriteEventPath: WatcherEventPathRewriter
}

/**
 * Deliberately synchronous. Every caller reserves and forks its watcher child
 * in the same tick as the subscribe call — capacity accounting and cancellation
 * ordering both depend on it — so an await here would open a window in which a
 * subscribe has been issued but no cancellable child exists. This is one
 * `realpath` per subscribe (not per event), on a directory the caller has
 * usually just stat'd, in a function that already calls `existsSync`.
 */
export function resolveWatcherRootPaths(
  requestedRoot: string,
  deps: {
    realpath?: (candidate: string) => string
    platform?: NodeJS.Platform
  } = {}
): WatcherRootPaths {
  let watchRoot = requestedRoot
  try {
    watchRoot = (deps.realpath ?? realpathSync.native)(requestedRoot)
  } catch {
    // Why: a vanished or unreadable root still gets a watcher attempt, which
    // owns its own failure reporting; fall back to the literal spelling rather
    // than fail here. Resolving the binding inside the try also keeps suites
    // that mock a partial node:fs from failing every watcher install.
  }
  return {
    watchRoot,
    rewriteEventPath: createRootPathRewriter(requestedRoot, watchRoot, deps.platform)
  }
}

/**
 * Returns the original array when nothing needed rewriting so the common
 * per-batch hot path stays allocation-free.
 */
export function rewriteWatcherEvents<T extends { path: string }>(
  events: T[],
  rewrite: WatcherEventPathRewriter
): T[] {
  let rewritten: T[] | null = null
  for (const [index, event] of events.entries()) {
    const path = rewrite(event.path)
    if (path === event.path) {
      rewritten?.push(event)
      continue
    }
    rewritten ??= events.slice(0, index)
    rewritten.push({ ...event, path })
  }
  return rewritten ?? events
}
