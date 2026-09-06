import { watch, type FSWatcher } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { resolveMacAppBundlePath } from '../../shared/mac-update-install-marker'

const MAC_BUNDLE_UPDATE_TIMEOUT_MS = 120_000

export function getMacAppBundlePath(executable: string): string | null {
  return resolveMacAppBundlePath(executable)
}

export async function waitForMacBundleVersion(
  executable: string,
  targetVersion: string,
  timeoutMs = MAC_BUNDLE_UPDATE_TIMEOUT_MS
): Promise<boolean> {
  return waitForMacBundleVersionMatching(executable, (v) => v === targetVersion, timeoutMs)
}

/**
 * Wait until the bundle stops reporting `fromVersion`.
 *
 * Why not wait for a specific target: the version we asked for is not necessarily the one the
 * installer stages — a later attempt can supersede ours. Waiting for *any* change is correct
 * whichever build lands, and avoids burning the whole timeout on a target nobody is installing.
 */
export async function waitForMacBundleVersionChange(
  executable: string,
  fromVersion: string,
  timeoutMs = MAC_BUNDLE_UPDATE_TIMEOUT_MS
): Promise<boolean> {
  return waitForMacBundleVersionMatching(
    executable,
    (v) => v !== null && v !== fromVersion,
    timeoutMs
  )
}

async function waitForMacBundleVersionMatching(
  executable: string,
  matches: (version: string | null) => boolean,
  timeoutMs: number
): Promise<boolean> {
  const appBundlePath = getMacAppBundlePath(executable)
  if (!appBundlePath) {
    return false
  }
  const infoPlistPath = resolve(appBundlePath, 'Contents', 'Info.plist')
  if (matches(await readMacBundleVersion(infoPlistPath))) {
    return true
  }

  return new Promise((resolveWait) => {
    let settled = false
    let checking = false
    let watcher: FSWatcher | null = null
    let poll: ReturnType<typeof setInterval> | null = null
    const finish = (ready: boolean): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timeout)
      if (poll) {
        clearInterval(poll)
      }
      watcher?.close()
      resolveWait(ready)
    }
    const check = (): void => {
      if (checking || settled) {
        return
      }
      checking = true
      void readMacBundleVersion(infoPlistPath)
        .then((version) => {
          if (matches(version)) {
            finish(true)
          }
        })
        .finally(() => {
          checking = false
        })
    }
    const timeout = setTimeout(() => finish(false), timeoutMs)
    poll = setInterval(check, 250)
    try {
      // Why: ShipIt replaces the whole .app, so watch its stable parent rather than an inode inside the old bundle.
      watcher = watch(dirname(appBundlePath), check)
      watcher.on('error', () => {
        watcher?.close()
        watcher = null
      })
    } catch {
      watcher = null
    }
    check()
  })
}

/** Reads the bundle's short version, or null when it cannot be read — which during a swap
 *  means "still installing", never "gone". */
export async function readMacBundleVersion(bundlePath: string): Promise<string | null> {
  const infoPlistPath = bundlePath.endsWith('Info.plist')
    ? bundlePath
    : resolve(bundlePath, 'Contents', 'Info.plist')
  try {
    const plist = await readFile(infoPlistPath, 'utf8')
    const match = /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/.exec(plist)
    return match?.[1]?.trim() || null
  } catch {
    return null
  }
}
