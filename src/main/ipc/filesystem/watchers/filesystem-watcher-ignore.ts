import { homedir } from 'node:os'
import { isAbsolute, join, relative } from 'node:path'

// Share high-churn exclusions across desktop and runtime watchers, following VS Code's recursive-watch defaults.
export const WATCHER_IGNORE_DIRS: string[] = [
  '.git',
  'node_modules',
  'dist',
  'build',
  '.next',
  '.cache',
  'target',
  '.venv',
  '__pycache__',
  '.dart_tool',
  '.gradle',
  '.turbo'
]

// FSEvents rejects all exclusions above eight paths; regex filtering covers the remaining names at every depth.
export const MACOS_FSEVENTS_EXCLUSION_PATH_LIMIT = 8

export type ParcelWatcherIgnoreOptions = {
  ignore?: string[]
  // Parcel forwards this native option despite omitting it from TS declarations (parcel-bundler/watcher#244).
  ignoreGlobs?: string[]
}

function escapeRegex(value: string): string {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')
}

function buildNestedDirectoryRegex(ignoreDirs: readonly string[]): string {
  const alternatives = ignoreDirs.map(escapeRegex).join('|')
  if (process.platform === 'win32') {
    return `^(?:[^\\\\/]+[\\\\/])*(?:${alternatives})(?:[\\\\/][\\s\\S]*)?$`
  }
  // Backslash is a valid POSIX filename character.
  return `^(?:[^/]+/)*(?:${alternatives})(?:/[\\s\\S]*)?$`
}

function isStrictAncestor(root: string, target: string): boolean {
  const fromRoot = relative(root, target)
  return fromRoot !== '' && !fromRoot.startsWith('..') && !isAbsolute(fromRoot)
}

/** macOS privacy-protected stores inside a recursive root. Parcel stats each changed path, and a stat
 *  inside another app's container raises the "access data from other apps" prompt in Orca's name on
 *  every write that app makes; a home-folder project would prompt endlessly. */
export function macosProtectedWatchExclusions(rootPath: string, homeDir = homedir()): string[] {
  const library = join(homeDir, 'Library')
  if (isStrictAncestor(rootPath, library)) {
    return [library]
  }
  return [join(library, 'Containers'), join(library, 'Group Containers')].filter((store) =>
    isStrictAncestor(rootPath, store)
  )
}

export function buildParcelWatcherIgnoreOptions(
  ignoreDirs: readonly string[],
  rootPath?: string
): ParcelWatcherIgnoreOptions {
  const protectedPaths =
    process.platform === 'darwin' && rootPath ? macosProtectedWatchExclusions(rootPath) : []
  if (ignoreDirs.length === 0 && protectedPaths.length === 0) {
    return {}
  }
  if (process.platform !== 'darwin') {
    // Parcel 2.5.6 leading-** globs cause pathological std::regex lookaheads; one component regex avoids that cost.
    return { ignoreGlobs: [buildNestedDirectoryRegex(ignoreDirs)] }
  }
  // Absolute paths go first so the FSEvents cap never drops them; Parcel also filters them before any stat.
  const daemonExcludedDirs = [...protectedPaths, ...ignoreDirs].slice(
    0,
    MACOS_FSEVENTS_EXCLUSION_PATH_LIMIT
  )
  return {
    ignore: daemonExcludedDirs,
    // Plain exclusions cover only the root; regex also prunes nested generated directories.
    ...(ignoreDirs.length > 0 ? { ignoreGlobs: [buildNestedDirectoryRegex(ignoreDirs)] } : {})
  }
}
