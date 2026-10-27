import { execFileSync } from 'node:child_process'

/** Written once a bundle is fully built; its absence is what marks a build still in flight. */
export const DEV_BUNDLE_MARKER_FILENAME = 'orca-dev-electron-app.json'

export function getDevBundleProcessTable(execFile = execFileSync) {
  // Use portable ps -ww, not macOS pgrep (no -a); truncated/missing commands could delete live bundles. Search raw paths; see isDevBundleInUse.
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

// Reclaim renamed/old-version Electron.app siblings: dev only clears its own target, leaving ~270MB per stale bundle (143/38GB observed).

// Age starts at mkdir, not activity: app copy/signing does not refresh parent mtime.
// Concurrent builds beyond this hard cutoff can be deleted; 130–200s builds leave 5–10x margin.
export const IN_PROGRESS_WINDOW_MS = 15 * 60 * 1000

// Protect current, live and unfinished-copy bundles: no process exists to reveal an in-flight copy before its marker.
// Search known absolute paths in raw ps text; parsing twice missed live paths. Trailing slash distinguishes dir from dir2.
export function isDevBundleInUse(dir, processTable) {
  // Check both macOS /tmp and /private/tmp spellings or ps can hide a live bundle; extra protection is safe.
  const alternate = dir.startsWith('/private/') ? dir.slice('/private'.length) : `/private${dir}`
  return processTable.includes(`${dir}/`) || processTable.includes(`${alternate}/`)
}

export function selectStaleDevBundleDirs({
  bundles,
  currentDir,
  processTable,
  nowMs,
  minAgeMs = 0
}) {
  return bundles
    .filter(({ dir, hasMarker, mtimeMs }) => {
      if (dir === currentDir || isDevBundleInUse(dir, processTable)) {
        return false
      }
      if (minAgeMs > 0 && nowMs - mtimeMs < minAgeMs) {
        return false
      }
      const buildInFlight = !hasMarker && nowMs - mtimeMs < IN_PROGRESS_WINDOW_MS
      return !buildInFlight
    })
    .map(({ dir }) => dir)
}
