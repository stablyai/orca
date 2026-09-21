import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { basename, dirname, join, posix as pathPosix, win32 as pathWin32 } from 'node:path'
import { foldWslUncPathCaseInsensitiveParts } from '../../shared/wsl-paths'
import type { CodexEventLabel, CodexTrustEntry } from './config-toml-trust'

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize)
  }
  if (value && typeof value === 'object') {
    const sorted: Record<string, unknown> = {}
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = canonicalize((value as Record<string, unknown>)[key])
    }
    return sorted
  }
  return value
}

function matcherPatternForEvent(
  eventLabel: CodexEventLabel,
  matcher: string | undefined
): string | undefined {
  switch (eventLabel) {
    case 'user_prompt_submit':
    case 'stop':
      return undefined
    case 'pre_tool_use':
    case 'permission_request':
    case 'post_tool_use':
    case 'pre_compact':
    case 'post_compact':
    case 'session_start':
    case 'subagent_start':
    case 'subagent_stop':
      return matcher
  }
}

export function computeCodexTrustedHash(entry: CodexTrustEntry): string {
  const handler: Record<string, unknown> = {
    type: 'command',
    command: entry.command,
    timeout: Math.max(1, entry.timeoutSec ?? 600),
    async: entry.async ?? false
  }
  if (entry.statusMessage !== undefined) {
    handler.statusMessage = entry.statusMessage
  }
  const identity: Record<string, unknown> = {
    event_name: entry.eventLabel,
    hooks: [handler]
  }
  const matcher = matcherPatternForEvent(entry.eventLabel, entry.matcher)
  if (matcher !== undefined) {
    identity.matcher = matcher
  }
  const serialized = JSON.stringify(canonicalize(identity))
  return `sha256:${createHash('sha256').update(serialized).digest('hex')}`
}

export function computeCodexTrustKey(entry: CodexTrustEntry): string {
  return `${normalizeCodexTrustSourcePath(entry.sourcePath)}:${entry.eventLabel}:${entry.groupIndex}:${entry.handlerIndex}`
}

export function getExplicitHomeCodexHookSourcePath(sourcePath: string): string {
  if (process.platform !== 'win32' && isUnambiguousWindowsPath(sourcePath)) {
    return normalizeCodexTrustSourcePath(sourcePath)
  }
  try {
    // Why: hook discovery resolves the explicit home but keeps the hooks.json leaf logical.
    return normalizeCodexTrustSourcePath(
      join(realpathSync.native(dirname(sourcePath)), basename(sourcePath))
    )
  } catch {
    return normalizeCodexTrustSourcePath(sourcePath)
  }
}

export function normalizeCodexTrustSourcePath(sourcePath: string): string {
  if (isWindowsPathForTrustSource(sourcePath)) {
    const withoutDevicePrefix = stripWindowsDevicePrefix(sourcePath)
    const normalized = pathWin32.isAbsolute(withoutDevicePrefix)
      ? pathWin32.normalize(withoutDevicePrefix)
      : pathWin32.resolve(withoutDevicePrefix)
    return trimNonRootTrailingSeparators(normalized, pathWin32.parse(normalized).root, /[\\/]/)
  }
  const normalized = pathPosix.isAbsolute(sourcePath)
    ? pathPosix.normalize(sourcePath)
    : pathPosix.resolve(sourcePath)
  return trimNonRootTrailingSeparators(normalized, pathPosix.parse(normalized).root, /\//)
}

function trimNonRootTrailingSeparators(path: string, root: string, separators: RegExp): string {
  let end = path.length
  while (end > root.length && separators.test(path[end - 1]!)) {
    end -= 1
  }
  return path.slice(0, end)
}

function stripWindowsDevicePrefix(sourcePath: string): string {
  const unc = /^(?:\\\\\?|\\\\\.)\\UNC\\/i.exec(sourcePath)
  if (unc) {
    return `\\\\${sourcePath.slice(unc[0].length)}`
  }
  const drive = /^(?:\\\\\?|\\\\\.)\\(?=[A-Za-z]:[\\/])/i.exec(sourcePath)
  return drive ? sourcePath.slice(drive[0].length) : sourcePath
}

export function usesWindowsCodexPathSeparators(sourcePath: string): boolean {
  return isUnambiguousWindowsPath(sourcePath) || sourcePath.startsWith('//')
}

function isUnambiguousWindowsPath(sourcePath: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(sourcePath) || sourcePath.startsWith('\\\\')
}

function isWindowsPathForTrustSource(sourcePath: string): boolean {
  return (
    isUnambiguousWindowsPath(sourcePath) ||
    (process.platform === 'win32' &&
      (sourcePath.startsWith('//') || !pathPosix.isAbsolute(sourcePath)))
  )
}

export function normalizeCodexTrustProjectPath(projectPath: string): string {
  if (!usesWindowsCodexPathSeparators(projectPath)) {
    return projectPath
  }
  const slashedPath = projectPath.replace(/\\/g, '/')
  return foldWslUncPathCaseInsensitiveParts(slashedPath) ?? slashedPath.toLowerCase()
}

export function codexTrustSourcePathsEqual(left: string, right: string): boolean {
  const normalizeForLookup = (sourcePath: string): string =>
    normalizeCodexTrustProjectPath(
      sourcePath.startsWith('//') ? sourcePath : normalizeCodexTrustSourcePath(sourcePath)
    )
  return normalizeForLookup(left) === normalizeForLookup(right)
}

export function normalizeCodexTrustProjectRevocationPath(projectPath: string): string {
  const normalized = normalizeCodexTrustProjectPath(projectPath)
  return usesWindowsCodexPathSeparators(projectPath) ? normalized.toLowerCase() : normalized
}

export type ParsedCodexTrustKey = {
  sourcePath: string
  eventLabel: CodexEventLabel
  groupIndex: number
  handlerIndex: number
}

export function parseCodexTrustKey(key: string): ParsedCodexTrustKey | null {
  const lastColon = key.lastIndexOf(':')
  if (lastColon === -1) {
    return null
  }
  const handlerStr = key.slice(lastColon + 1)
  if (!isCanonicalNonNegativeInt(handlerStr)) {
    return null
  }
  const secondLast = key.lastIndexOf(':', lastColon - 1)
  if (secondLast === -1) {
    return null
  }
  const groupStr = key.slice(secondLast + 1, lastColon)
  if (!isCanonicalNonNegativeInt(groupStr)) {
    return null
  }
  const thirdLast = key.lastIndexOf(':', secondLast - 1)
  if (thirdLast === -1) {
    return null
  }
  const eventLabel = key.slice(thirdLast + 1, secondLast)
  if (!isCodexEventLabel(eventLabel)) {
    return null
  }
  const sourcePath = key.slice(0, thirdLast)
  if (sourcePath.length === 0) {
    return null
  }
  return {
    sourcePath,
    eventLabel,
    groupIndex: Number(groupStr),
    handlerIndex: Number(handlerStr)
  }
}

function isCanonicalNonNegativeInt(value: string): boolean {
  return /^(0|[1-9]\d*)$/.test(value)
}

function isCodexEventLabel(value: string): value is CodexEventLabel {
  return (
    value === 'pre_tool_use' ||
    value === 'permission_request' ||
    value === 'post_tool_use' ||
    value === 'pre_compact' ||
    value === 'post_compact' ||
    value === 'session_start' ||
    value === 'user_prompt_submit' ||
    value === 'subagent_start' ||
    value === 'subagent_stop' ||
    value === 'stop'
  )
}

export function normalizeCodexHookTrustLookupKey(key: string): string {
  const parsed = parseCodexTrustKey(key)
  const foldedPath = normalizeCodexTrustProjectPath(
    parsed
      ? parsed.sourcePath.startsWith('//')
        ? parsed.sourcePath
        : normalizeCodexTrustSourcePath(parsed.sourcePath)
      : key
  )
  return parsed
    ? `${foldedPath}:${parsed.eventLabel}:${parsed.groupIndex}:${parsed.handlerIndex}`
    : foldedPath
}
