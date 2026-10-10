import { getAppEnvironment } from '../../../shared/app-environment'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import type { PersistedState } from '../../../shared/persisted-state-types'
import { hardenExistingSecureFile } from '../../../shared/secure-file'
import { MOBILE_PAIRING_USERDATA_FILES } from '../../runtime/mobile-pairing-files'

// Why capture once (not a module const, not per-call): a const resolves before configureDevUserDataPath() redirects userData (dev/prod collide);
// per-call resolves after app.setName('Orca') flips path case and loses data on case-sensitive FS. index.ts calls initDataPath() at the right moment.
let _dataFile: string | null = null
let _userDataDir: string | null = null

export function initDataPath(): void {
  const userDataDir = getAppEnvironment().getPath('userData')
  _userDataDir = userDataDir
  _dataFile = join(userDataDir, 'orca-data.json')
}

export function getDataFile(): string {
  if (!_dataFile) {
    // Safety fallback — should not be hit in normal startup.
    const userDataDir = getAppEnvironment().getPath('userData')
    _userDataDir = userDataDir
    _dataFile = join(userDataDir, 'orca-data.json')
  }
  return _dataFile
}

// Why a sidecar: githubCache refreshes every poll and would rewrite the whole multi-MB orca-data.json each cycle.
// Snapshotted best-effort at quit for instant badges next launch; safe to lose.
export function getGithubCacheFile(dataFile = getDataFile()): string {
  return join(dirname(dataFile), 'orca-github-cache.json')
}

export function readGithubCacheSnapshot(dataFile: string): PersistedState['githubCache'] | null {
  try {
    const parsed = JSON.parse(readFileSync(getGithubCacheFile(dataFile), 'utf-8')) as unknown
    const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
      typeof value === 'object' && value !== null && !Array.isArray(value)
    if (
      isPlainRecord(parsed) &&
      isPlainRecord((parsed as { pr?: unknown }).pr) &&
      isPlainRecord((parsed as { issue?: unknown }).issue)
    ) {
      return parsed as PersistedState['githubCache']
    }
  } catch {
    // Missing or corrupt snapshot: start with an empty cache and refetch.
  }
  return null
}

/**
 * Return the userData directory captured at initDataPath() time, before app.setName() can change how getAppEnvironment().getPath('userData') resolves.
 *
 * Subsystems sharing storage with orca-data.json read this instead of resolving late, which on case-sensitive FS can lose paired devices.
 */
export function getCanonicalUserDataPath(): string {
  if (!_userDataDir) {
    // Safety fallback — should not be hit in normal startup.
    _userDataDir = getAppEnvironment().getPath('userData')
  }
  return _userDataDir
}

/**
 * Copy legacy mobile pairing credentials into the canonical userData directory.
 *
 * Copies the registry and E2EE keypair forward as a pair so an update doesn't force a re-pair or mix devices with the wrong key.
 *
 * Sources are deliberately left in place: a copy-then-delete has no atomic form across the userData
 * dirs, and losing the originals to a crash mid-migration would strand every paired device. They stay
 * readable by an older build the user rolls back to; removing them is a separate cleanup decision.
 */
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
      // Why: copyFileSync drops Windows ACLs, so re-assert current-user-only on these credential copies (device tokens, E2EE key).
      hardenExistingSecureFile(targetPath)
    }
  } catch (error) {
    // Why: a half-copied pair mixes devices with the wrong key, and the existing-target guard above would block the retry.
    for (const targetPath of copied) {
      try {
        rmSync(targetPath, { force: true })
      } catch {
        // Best effort — leave the retry guard to the next launch.
      }
    }
    console.error('[persistence] Failed to migrate mobile pairing files forward:', error)
  }
}
