import { getAppEnvironment } from '../../../shared/app-environment'
import { copyFileSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { hardenExistingSecureFile } from '../../../shared/secure-storage/secure-file'
import { MOBILE_PAIRING_USERDATA_FILES } from '../../runtime/rpc/server/pairing/mobile-pairing-files'

// Capture after dev redirection but before app.setName changes path casing and loses case-sensitive data.
let _dataFile: string | null = null
let _userDataDir: string | null = null

export function initDataPath(): void {
  const userDataDir = getAppEnvironment().getPath('userData')
  _userDataDir = userDataDir
  _dataFile = join(userDataDir, 'orca-data.json')
}

export function getDataFile(): string {
  if (!_dataFile) {
    const userDataDir = getAppEnvironment().getPath('userData')
    _userDataDir = userDataDir
    _dataFile = join(userDataDir, 'orca-data.json')
  }
  return _dataFile
}

// Cache polls use a disposable sidecar to avoid full-profile rewrites; snapshots accelerate next-launch badges.
export function getGithubCacheFile(dataFile = getDataFile()): string {
  return join(dirname(dataFile), 'orca-github-cache.json')
}

/** Reuse the path captured before app.setName; late resolution can change casing and strand paired devices. */
export function getCanonicalUserDataPath(): string {
  if (!_userDataDir) {
    _userDataDir = getAppEnvironment().getPath('userData')
  }
  return _userDataDir
}

/** Copy registry/keypair together; retain originals for crash recovery and older builds. */
export function migrateMobilePairingDataToCanonicalUserDataPath(sourceUserDataDir: string): void {
  const targetUserDataDir = getCanonicalUserDataPath()
  if (resolve(sourceUserDataDir) === resolve(targetUserDataDir)) {
    return
  }

  const migrations = MOBILE_PAIRING_USERDATA_FILES.map((fileName) => ({
    sourcePath: join(sourceUserDataDir, fileName),
    targetPath: join(targetUserDataDir, fileName)
  }))
  if (migrations.some(({ sourcePath }) => !existsSync(sourcePath))) {
    return
  }
  if (migrations.some(({ targetPath }) => existsSync(targetPath))) {
    return
  }

  mkdirSync(targetUserDataDir, { recursive: true })
  const copied: string[] = []
  try {
    for (const { sourcePath, targetPath } of migrations) {
      copyFileSync(sourcePath, targetPath)
      copied.push(targetPath)
      // Reapply private permissions because copyFileSync does not preserve Windows ACLs.
      hardenExistingSecureFile(targetPath)
    }
  } catch (error) {
    // Remove partial copies or the target-exists guard would block recovery with a mismatched registry/keypair.
    for (const targetPath of copied) {
      try {
        rmSync(targetPath, { force: true })
      } catch {}
    }
    console.error('[persistence] Failed to migrate mobile pairing files forward:', error)
  }
}
