import { watch, type FSWatcher } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

const MAC_BUNDLE_UPDATE_TIMEOUT_MS = 120_000

export function getMacAppBundlePath(executable: string): string | null {
  if (process.platform !== 'darwin') {
    return null
  }
  const macOsDir = dirname(executable)
  const contentsDir = dirname(macOsDir)
  const appBundlePath = dirname(contentsDir)
  return appBundlePath.endsWith('.app') ? appBundlePath : null
}

export async function waitForMacBundleVersion(
  executable: string,
  targetVersion: string,
  timeoutMs = MAC_BUNDLE_UPDATE_TIMEOUT_MS
): Promise<boolean> {
  const appBundlePath = getMacAppBundlePath(executable)
  if (!appBundlePath) {
    return false
  }
  const infoPlistPath = resolve(appBundlePath, 'Contents', 'Info.plist')
  if ((await readMacBundleVersion(infoPlistPath)) === targetVersion) {
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
          if (version === targetVersion) {
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

async function readMacBundleVersion(infoPlistPath: string): Promise<string | null> {
  try {
    const plist = await readFile(infoPlistPath, 'utf8')
    const match = /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/.exec(plist)
    return match?.[1]?.trim() || null
  } catch {
    return null
  }
}
