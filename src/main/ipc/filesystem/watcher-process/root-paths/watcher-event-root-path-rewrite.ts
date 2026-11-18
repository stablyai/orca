/** Resolve roots for Linux symlink watches; rewrite canonical macOS/Windows event paths back to caller spelling. */
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

// Backslash is a valid POSIX filename character; treat it as a separator only on Windows.
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
  // Unicode/case folding can change byte length; match segment counts before slicing raw paths.
  const foldSegment = (segment: string): string => {
    const normalized = segment.normalize('NFC')
    return caseInsensitive ? normalized.toLowerCase() : normalized
  }
  const foldedCanonicalSegments = canonicalSegments.map(foldSegment)

  return (eventPath) => {
    if (eventPath === requested.value || eventPath.startsWith(requested.prefix)) {
      return eventPath
    }
    // Exact canonical prefixes avoid case/Unicode normalization on ordinary aliased paths.
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
  watchRoot: string
  rewriteEventPath: WatcherEventPathRewriter
}

/** Resolve synchronously: subscribe must reserve its cancellable child in the same tick for capacity and cancellation ordering. */
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
    // Unreadable roots still reach watcher-owned failure reporting using their literal spelling.
  }
  return {
    watchRoot,
    rewriteEventPath: createRootPathRewriter(requestedRoot, watchRoot, deps.platform)
  }
}

/** Preserve array identity when no path changes, avoiding hot-path allocations. */
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
