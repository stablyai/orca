import { statSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, resolve, win32 } from 'node:path'

const WINDOWS_ABSOLUTE_PATH_PATTERN = /^([a-zA-Z]:[\\/]|\\\\)/

export type WorkspacePathLaunchArgvOptions = {
  isPackaged: boolean
  cwd?: string
}

/**
 * Resolves one candidate string to an existing local directory.
 *
 * Returns the normalized absolute path when the candidate is path-shaped
 * (absolute, `~`-prefixed, explicit relative, or a Windows drive/UNC form) and
 * points at a directory on disk; returns null for anything else so callers can
 * skip it silently.
 */
export function resolveExistingDirectoryPath(
  candidate: string,
  options: { cwd?: string; allowBareDotSegments?: boolean } = {},
  isDirectory: (path: string) => boolean = defaultIsDirectory
): string | null {
  const expanded = expandHomeTilde(candidate)
  if (
    !isWorkspacePathLike(expanded, {
      allowBareDotSegments: options.allowBareDotSegments === true
    })
  ) {
    return null
  }
  const absolute = windowsAbsolutePath(expanded) ?? resolve(options.cwd ?? process.cwd(), expanded)
  return isDirectory(absolute) ? absolute : null
}

/**
 * Returns the first launch argument that resolves to an existing directory.
 *
 * Flags (`-…`) are skipped, and bare `.`/`..` app indicators are only accepted
 * in packaged launches where they cannot be Electron's dev app indicator.
 */
export function extractWorkspacePathFromArgv(
  argv: readonly string[],
  options: WorkspacePathLaunchArgvOptions,
  isDirectory: (path: string) => boolean = defaultIsDirectory
): string | null {
  for (const raw of argv.slice(1)) {
    if (!raw || raw.startsWith('-')) {
      continue
    }
    const resolved = resolveExistingDirectoryPath(
      raw,
      {
        cwd: options.cwd,
        // Why: `electron .` dev launches pass the app indicator, which must never read as a project path.
        allowBareDotSegments: options.isPackaged
      },
      isDirectory
    )
    if (!resolved) {
      continue
    }
    return resolved
  }
  return null
}

/**
 * Queued folder-open intents that arrived before the renderer could receive pushed events.
 */
export class WorkspacePathLaunchQueue {
  private pendingFolderPaths: string[] = []

  /** Buffers an intent until the renderer pulls it via the drain endpoint. */
  queue(folderPath: string): void {
    this.pendingFolderPaths.push(folderPath)
  }

  /** Drains every queued intent so a reload cannot replay stale launches. */
  drain(): string[] {
    const drained = this.pendingFolderPaths
    this.pendingFolderPaths = []
    return drained
  }
}

/** Probe used in production; injectable in tests to avoid touching real files. */
function defaultIsDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/** Expands a leading `~` (bare or before a separator) to the user's home directory. */
function expandHomeTilde(candidate: string): string {
  if (/^~[\\/]/.test(candidate)) {
    return `${homedir()}/${candidate.slice(2)}`
  }
  if (candidate === '~') {
    return homedir()
  }
  return candidate
}

/**
 * Whether the candidate even looks like a filesystem path.
 *
 * Guards against subcommand words and other bare tokens being mistaken for
 * project folders; bare dot segments are gated by `allowBareDotSegments`.
 */
function isWorkspacePathLike(
  candidate: string,
  options: { allowBareDotSegments: boolean }
): boolean {
  if (candidate.startsWith('~') || isAbsolute(candidate)) {
    return true
  }
  if (WINDOWS_ABSOLUTE_PATH_PATTERN.test(candidate)) {
    return true
  }
  if (candidate === '.' || candidate === '..') {
    return options.allowBareDotSegments
  }
  return candidate.startsWith('./') || candidate.startsWith('../')
}

/**
 * Normalizes Windows drive-letter and UNC candidates with win32 rules.
 *
 * Returns null for anything else; using `win32.normalize` keeps the result
 * stable no matter which platform the app is running on.
 */
function windowsAbsolutePath(candidate: string): string | null {
  if (!WINDOWS_ABSOLUTE_PATH_PATTERN.test(candidate)) {
    return null
  }
  return win32.normalize(candidate)
}
