// Canonical ignore list for recursive worktree watchers (mirrors VS Code's
// predefined recursive-watch excludes). Shared by the explorer watcher and the
// runtime file-watcher host so every @parcel/watcher subscription gets the
// same high-churn exclusions.
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
  '.worktrees'
]

// Why: macOS FSEventStreamSetExclusionPaths accepts at most 8 paths and fails
// closed — one entry over the cap and @parcel/watcher silently loses ALL
// daemon-side exclusions, so fseventsd delivers every node_modules/.git event
// to this process (measured ~29x client CPU plus daemon-side delivery load).
// The first 8 names get root-level daemon exclusions; the regex covers all names at every depth.
export const MACOS_FSEVENTS_EXCLUSION_PATH_LIMIT = 8

export type ParcelWatcherIgnoreOptions = {
  ignore?: string[]
  // @parcel/watcher's wrapper preserves this native option even though its
  // public TypeScript declaration omits it. See parcel-bundler/watcher#244.
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
  // Why: backslash is a legal POSIX filename character, not a path separator.
  return `^(?:[^/]+/)*(?:${alternatives})(?:/[\\s\\S]*)?$`
}

export function buildParcelWatcherIgnoreOptions(
  ignoreDirs: readonly string[]
): ParcelWatcherIgnoreOptions {
  if (ignoreDirs.length === 0) {
    return {}
  }
  if (process.platform !== 'darwin') {
    // Why: Parcel 2.5.6 turns leading-** globs into nested-lookahead regexes
    // that are pathological in native std::regex (10-17x slower upstream).
    // One component-aware regex preserves nested pruning without that CPU cost.
    return { ignoreGlobs: [buildNestedDirectoryRegex(ignoreDirs)] }
  }
  const daemonExcludedDirs = ignoreDirs.slice(0, MACOS_FSEVENTS_EXCLUSION_PATH_LIMIT)
  return {
    ignore: [...daemonExcludedDirs],
    // Why: plain exclusions resolve under the root, leaving nested generated directories unfiltered.
    ignoreGlobs: [buildNestedDirectoryRegex(ignoreDirs)]
  }
}
