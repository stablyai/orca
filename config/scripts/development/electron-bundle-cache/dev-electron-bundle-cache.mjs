import { execFileSync } from 'node:child_process'
import { readdirSync, statSync, utimesSync } from 'node:fs'
import path from 'node:path'

/** Written once a bundle is fully built and signed; the launcher only reuses bundles that have it. */
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

// Age restarts when the launcher checks, reuses or finishes building a bundle (touchDevBundle).
// Covers build-to-spawn, when no process reveals the bundle; 130–200s builds leave 5–10x margin.
const RECENT_DEV_BUNDLE_WINDOW_MS = 15 * 60 * 1000

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
  const protectedAgeMs = Math.max(minAgeMs, RECENT_DEV_BUNDLE_WINDOW_MS)
  return bundles
    .filter(
      ({ dir, mtimeMs }) =>
        dir !== currentDir &&
        !isDevBundleInUse(dir, processTable) &&
        nowMs - mtimeMs >= protectedAgeMs
    )
    .map(({ dir }) => dir)
}

export function collectDevBundles(worktree) {
  const root = path.join(worktree, 'out', 'electron-dev')
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => {
        const dir = path.join(root, entry.name)
        return { dir, mtimeMs: statSync(dir, { throwIfNoEntry: false })?.mtimeMs ?? 0 }
      })
  } catch {
    return []
  }
}

export function touchDevBundle(dir) {
  const now = new Date()
  try {
    utimesSync(dir, now, now)
  } catch {}
}
