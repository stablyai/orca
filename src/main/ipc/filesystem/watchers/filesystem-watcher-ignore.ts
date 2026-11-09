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
  '.turbo',
  // Home-level folder workspaces otherwise watch all AppData install and temp churn (#40204).
  'AppData'
]

// Installers stage under suffixed dirs (Docker Desktop: DockerDesktop.staging) and extract Electron
// archives into them; Electron's asar fs integration opens and caches a handle on any *.asar path the
// main process stats, locking installers out of their staged files (#40204).
const WATCHER_IGNORE_DIR_SUFFIXES = ['.staging', '.asar']

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

function buildNestedDirectoryRegex(
  ignoreDirs: readonly string[],
  ignoreDirSuffixes: readonly string[]
): string {
  // Backslash is a valid POSIX filename character, so only the Windows dialect excludes it.
  const componentChar = process.platform === 'win32' ? '[^\\\\/]' : '[^/]'
  const componentSep = process.platform === 'win32' ? '[\\\\/]' : '/'
  const alternatives = [
    ...ignoreDirs.map(escapeRegex),
    ...ignoreDirSuffixes.map((suffix) => `${componentChar}+${escapeRegex(suffix)}`)
  ].join('|')
  return `^(?:${componentChar}+${componentSep})*(?:${alternatives})(?:${componentSep}[\\s\\S]*)?$`
}

export function buildParcelWatcherIgnoreOptions(
  ignoreDirs: readonly string[]
): ParcelWatcherIgnoreOptions {
  if (ignoreDirs.length === 0 && WATCHER_IGNORE_DIR_SUFFIXES.length === 0) {
    return {}
  }
  if (process.platform !== 'darwin') {
    // Parcel 2.5.6 leading-** globs cause pathological std::regex lookaheads; one component regex avoids that cost.
    return { ignoreGlobs: [buildNestedDirectoryRegex(ignoreDirs, WATCHER_IGNORE_DIR_SUFFIXES)] }
  }
  const daemonExcludedDirs = ignoreDirs.slice(0, MACOS_FSEVENTS_EXCLUSION_PATH_LIMIT)
  return {
    ignore: [...daemonExcludedDirs],
    // Plain exclusions cover only the root; regex also prunes nested generated directories.
    ignoreGlobs: [buildNestedDirectoryRegex(ignoreDirs, WATCHER_IGNORE_DIR_SUFFIXES)]
  }
}
