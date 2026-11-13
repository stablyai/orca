import { stat } from 'node:fs/promises'
import { app } from 'electron'
import type { InstalledBundleChange } from '../../../shared/installed-bundle-change'
import { readAsarPackageVersion } from './asar-package-version'

type BundleStamp = { ino: number; size: number; mtimeMs: number }

let launched: { asarPath: string; stamp: BundleStamp; version: string } | null = null

async function stampOf(asarPath: string): Promise<BundleStamp | null> {
  try {
    // The archive path itself bypasses Electron's asar layer, so this is the file on disk.
    const stats = await stat(asarPath)
    return { ino: stats.ino, size: stats.size, mtimeMs: stats.mtimeMs }
  } catch {
    return null
  }
}

/** Record which archive this process launched from; call once at startup, before any package manager can swap it. */
export async function captureInstalledBundleIdentity(): Promise<void> {
  const asarPath = app.getAppPath()
  if (!app.isPackaged || !asarPath.endsWith('.asar')) {
    return
  }
  const stamp = await stampOf(asarPath)
  if (stamp) {
    launched = { asarPath, stamp, version: app.getVersion() }
  }
}

/**
 * Linux package managers, Homebrew and the manual-install card all replace `app.asar` under a
 * running app. The running code keeps working until it lazy-loads a chunk whose hashed name or
 * byte offset changed, so compare the archive on disk with the one this process started from.
 */
export async function readInstalledBundleChange(): Promise<InstalledBundleChange> {
  if (!launched) {
    return { changed: false, runningVersion: app.getVersion(), installedVersion: null }
  }
  const current = await stampOf(launched.asarPath)
  const changed =
    current !== null &&
    (current.ino !== launched.stamp.ino ||
      current.size !== launched.stamp.size ||
      current.mtimeMs !== launched.stamp.mtimeMs)
  return {
    changed,
    runningVersion: launched.version,
    installedVersion: changed ? await readAsarPackageVersion(launched.asarPath) : launched.version
  }
}
