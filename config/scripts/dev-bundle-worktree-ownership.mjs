import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import path from 'node:path'

import { DEV_BUNDLE_MARKER_FILENAME } from './dev-electron-bundle-cache.mjs'

// Dev Electron bundles live in one cache root shared by every worktree; the marker's
// sourceAppPath (inside the owning worktree's node_modules) is what ties a bundle to its worktree.

export function readDevBundleSourceAppPath(dir) {
  try {
    const marker = JSON.parse(readFileSync(path.join(dir, DEV_BUNDLE_MARKER_FILENAME), 'utf8'))
    return typeof marker.sourceAppPath === 'string' ? marker.sourceAppPath : null
  } catch {
    return null
  }
}

export function pruneRemovedWorktreeElectronApps(cacheRoot, currentDistDir) {
  if (!existsSync(cacheRoot)) {
    return
  }

  let runningExecutables = []
  try {
    runningExecutables = execFileSync('/bin/ps', ['-axo', 'comm='], { encoding: 'utf8' })
      .split('\n')
      .filter(Boolean)
  } catch {
    // Keep stale bundles when process inspection is unavailable rather than
    // deleting a helper executable that another dev instance may still need.
    return
  }

  for (const entry of readdirSync(cacheRoot, { withFileTypes: true })) {
    const distDir = path.join(cacheRoot, entry.name)
    if (!entry.isDirectory() || distDir === currentDistDir) {
      continue
    }

    try {
      const marker = JSON.parse(
        readFileSync(path.join(distDir, DEV_BUNDLE_MARKER_FILENAME), 'utf8')
      )
      if (
        typeof marker.sourceAppPath !== 'string' ||
        typeof marker.appBundleName !== 'string' ||
        existsSync(marker.sourceAppPath)
      ) {
        continue
      }
      const appPath = path.join(distDir, marker.appBundleName)
      // Why: Chromium helpers run executables elsewhere in the app bundle and
      // can outlive the browser briefly, so any live bundle executable protects it.
      if (
        runningExecutables.some(
          (executablePath) =>
            executablePath === appPath || executablePath.startsWith(`${appPath}${path.sep}`)
        )
      ) {
        continue
      }
      rmSync(distDir, { recursive: true, force: true })
    } catch {
      // Only prune cache entries carrying a valid Orca-owned marker.
    }
  }
}
