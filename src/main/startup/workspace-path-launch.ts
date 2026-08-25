import { statSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, resolve, win32 } from 'node:path'

const WINDOWS_ABSOLUTE_PATH_PATTERN = /^([a-zA-Z]:[\\/]|\\\\)/

export type WorkspacePathLaunchArgvOptions = {
  isPackaged: boolean
  cwd?: string
}

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

/** Queued folder-open intents that arrived before the renderer could receive pushed events. */
export class WorkspacePathLaunchQueue {
  private pendingFolderPaths: string[] = []

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

function defaultIsDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

function expandHomeTilde(candidate: string): string {
  if (/^~[\\/]/.test(candidate)) {
    return `${homedir()}/${candidate.slice(2)}`
  }
  if (candidate === '~') {
    return homedir()
  }
  return candidate
}

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

function windowsAbsolutePath(candidate: string): string | null {
  if (!WINDOWS_ABSOLUTE_PATH_PATTERN.test(candidate)) {
    return null
  }
  return win32.normalize(candidate)
}
