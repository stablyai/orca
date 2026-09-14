import { execFileSync } from 'node:child_process'

/** Written once a bundle is fully built; its absence is what marks a build still in flight. */
export const DEV_BUNDLE_MARKER_FILENAME = 'orca-dev-electron-app.json'

export function getDevBundleProcessTable(execFile = execFileSync) {
  // Not pgrep: macOS pgrep has no -a (a Linux procps extension) and silently prints bare PIDs,
  // which reads as "nothing is running" and deletes a live bundle. -ww keeps the command column
  // from being truncated. The raw text is searched directly; see isDevBundleInUse for why it is
  // deliberately not parsed into paths.
  try {
    return execFile('/bin/ps', ['-Awwo', 'command='], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000
    })
  } catch {
    // Treating a failure as "nothing live" would risk deleting a running bundle, so skip pruning.
    return null
  }
}

// Why this module exists: `out/electron-dev` accumulates one ~270MB copy of Electron.app per
// (branch title x Electron version x bundle layout). The runner only ever clears the directory it is
// about to rebuild, so siblings from renamed branches and past upgrades are never reclaimed --
// measured at 143 directories / 38GB across one developer's worktrees.

// Measured from BUILD START, not from last activity: a directory's mtime only changes when a
// top-level entry is created, so it freezes once `<app>.app` appears and the 276MB copy, helper
// compiles and signing that follow never refresh it. So this is a hard cliff -- a build still
// running after this long becomes eligible for deletion by a concurrent instance. Full builds
// measured at 130-200s, so the margin is 5-10x.
export const IN_PROGRESS_WINDOW_MS = 15 * 60 * 1000

/**
 * Which cached bundle directories are safe to reclaim.
 *
 * Three things are protected, and every one of them is a directory some other process still needs:
 *
 * - the bundle this run is about to use;
 * - a bundle a live dev instance is running from. Deleting it can crash that instance mid-session,
 *   and developers routinely run several at once;
 * - a bundle still being copied. Between `mkdirSync` and the marker write it exists, has no marker,
 *   and cannot appear in the process table because its instance has not launched yet -- so a
 *   concurrently starting instance would otherwise delete it mid-copy.
 *
 * `processTable` is raw `ps` output, searched for each candidate rather than parsed into paths.
 * Parsing was tried twice and failed twice in the same dangerous direction -- a regex that missed a
 * live process yielded "nothing is running" and deleted its bundle. Searching for a known absolute
 * directory is immune to spaces and shell-significant characters in the path, and the trailing
 * slash keeps `<dir>2` from being mistaken for `<dir>`.
 */
export function isDevBundleInUse(dir, processTable) {
  // Both spellings: macOS realpaths /tmp to /private/tmp, and `ps` preserves whatever spelling the
  // process was launched with. A mismatch would read as "not running" and delete a live bundle.
  // Checking both can only ever protect more, which is the safe direction.
  const alternate = dir.startsWith('/private/') ? dir.slice('/private'.length) : `/private${dir}`
  return processTable.includes(`${dir}/`) || processTable.includes(`${alternate}/`)
}

export function selectStaleDevBundleDirs({ bundles, currentDir, processTable, nowMs }) {
  return bundles
    .filter(({ dir, hasMarker, mtimeMs }) => {
      if (dir === currentDir || isDevBundleInUse(dir, processTable)) {
        return false
      }
      const buildInFlight = !hasMarker && nowMs - mtimeMs < IN_PROGRESS_WINDOW_MS
      return !buildInFlight
    })
    .map(({ dir }) => dir)
}
