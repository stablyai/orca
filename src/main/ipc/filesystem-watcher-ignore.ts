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
  '__pycache__'
]

// Why: macOS FSEventStreamSetExclusionPaths accepts at most 8 paths and fails
// closed — one entry over the cap and @parcel/watcher silently loses ALL
// daemon-side exclusions, so fseventsd delivers every node_modules/.git event
// to this process (measured ~29x client CPU plus daemon-side delivery load).
// Keep the 8 highest-churn dirs as plain paths (daemon-excluded) and demote
// the rest to globs (userspace-filtered). Ordering of WATCHER_IGNORE_DIRS is
// therefore meaningful: the first 8 get true daemon-side exclusion on macOS.
export const MACOS_FSEVENTS_EXCLUSION_PATH_LIMIT = 8

export function buildParcelWatcherIgnoreOption(ignoreDirs: readonly string[]): string[] {
  if (process.platform !== 'darwin') {
    // Linux/Windows: @parcel/watcher resolves plain names to top-level-only
    // absolute paths, so nested node_modules/.git/build/etc. (monorepos) get
    // fully watched — on Linux that means one inotify watch per nested dir,
    // exhausting fs.inotify.max_user_watches. Nested globs match at any depth
    // (and **/dir still matches the top-level dir), pruning those subtrees.
    return ignoreDirs.flatMap((dir) => [`**/${dir}`, `**/${dir}/**`])
  }
  return [
    ...ignoreDirs.slice(0, MACOS_FSEVENTS_EXCLUSION_PATH_LIMIT),
    ...ignoreDirs
      .slice(MACOS_FSEVENTS_EXCLUSION_PATH_LIMIT)
      .flatMap((dir) => [`**/${dir}`, `**/${dir}/**`])
  ]
}
