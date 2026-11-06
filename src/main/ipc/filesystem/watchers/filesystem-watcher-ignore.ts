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
  '__pycache__'
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

export function buildParcelWatcherIgnoreOptions(
  ignoreDirs: readonly string[]
): ParcelWatcherIgnoreOptions {
  if (ignoreDirs.length === 0) {
    return {}
  }
  if (process.platform !== 'darwin') {
    // Parcel 2.5.6 leading-** globs cause pathological std::regex lookaheads; one component regex avoids that cost.
    return { ignoreGlobs: [buildNestedDirectoryRegex(ignoreDirs)] }
  }
  const daemonExcludedDirs = ignoreDirs.slice(0, MACOS_FSEVENTS_EXCLUSION_PATH_LIMIT)
  return {
    ignore: [...daemonExcludedDirs],
    // Plain exclusions cover only the root; regex also prunes nested generated directories.
    ignoreGlobs: [buildNestedDirectoryRegex(ignoreDirs)]
  }
}
