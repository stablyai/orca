import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import { isSafeOwnedDirectory } from '../../../../shared/secure-storage/owned-private-directory'
import { isProcessAlive } from '../../../../shared/remote-runtime/serve-supervisor/serve-bundle-coordination'
import { removeTree } from '../../../../shared/file-write/windows-transient-lock-removal'
import { isDirectChild } from '../../../filesystem/owned-temp-staging-root'
import { readRuntimeMetadataAsync } from '../../../runtime/rpc/server/runtime-metadata'
import {
  getRuntimeMetadataPath,
  type RuntimeMetadata
} from '../../../../shared/remote-runtime/bootstrap/runtime-bootstrap'
import { unixSocketPathFits } from '../../../../shared/network/unix-socket-path-limit'
import { errnoCodeOrUnknown } from '../../../../shared/errors/errno-code'
import { sendOrcadSidecarRequest } from '../orcad-sidecar-runtime-client'

const STOP_TIMEOUT_MS = 5_000
const ORPHAN_PROBE_TIMEOUT_MS = 2_000
const PROFILE_PREFIX = 'orcad-browser-'
// Lives in orcad's private data root, so only this instance can name a profile for removal.
const PROFILE_RECORD_FILE = 'browser-sidecar-profile.json'
const ProfileRecord = z.object({ profilePath: z.string() })
// In orcad's private data root, so the engine keeps its logins across restarts like a desktop profile.
const PERSISTENT_PROFILE_DIRECTORY = 'browser-sidecar-profile'
// Linux's largest pid plus the 4-character runtime suffix: the longest socket name a sidecar binds.
const LONGEST_SIDECAR_SOCKET_NAME = 'o-4194304-xxxx.sock'

// Chromium leaves these behind when killed; a different host name then reads as "in use elsewhere".
const CHROMIUM_SINGLETON_FILES = ['SingletonLock', 'SingletonSocket', 'SingletonCookie']

export type ElectronSidecarProfile = { path: string; persistent: boolean }

async function createTemporaryElectronSidecarProfile(
  orcadUserDataPath: string
): Promise<ElectronSidecarProfile> {
  return { path: await createElectronSidecarProfile(orcadUserDataPath), persistent: false }
}

/** Launches on the saved profile, and once on a temporary one when the app exits on it. */
export async function launchOnElectronSidecarProfile(
  orcadUserDataPath: string,
  launch: (profile: ElectronSidecarProfile) => Promise<void>,
  readyForRetry: () => Promise<boolean>
): Promise<void> {
  const profile = await prepareElectronSidecarProfile(orcadUserDataPath)
  try {
    await launch(profile)
  } catch (error) {
    if (!profile.persistent || !(await readyForRetry())) {
      throw error
    }
    // A saved profile this app can't open (a newer build's state, damage) must not cost the host its browser.
    console.warn(
      '[orcad] Browser sidecar exited on its saved profile; using a temporary one:',
      error
    )
    await launch(await createTemporaryElectronSidecarProfile(orcadUserDataPath))
  }
}

// Short /tmp, not macOS's long tmpdir(): the sidecar binds its runtime socket in its profile.
function temporaryRoot(): string {
  return process.platform === 'win32' ? tmpdir() : '/tmp'
}

function signalProcess(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal)
  } catch {
    // The sidecar already exited.
  }
}

export async function stopElectronSidecar(pid: number): Promise<void> {
  signalProcess(pid, 'SIGTERM')
  const deadline = Date.now() + STOP_TIMEOUT_MS
  while (isProcessAlive(pid) && Date.now() < deadline) {
    await delay(50)
  }
  if (isProcessAlive(pid)) {
    signalProcess(pid, 'SIGKILL')
  }
}

/** The profile the next sidecar runs on, once no sidecar a crashed orcad left behind still holds it. */
export async function prepareElectronSidecarProfile(
  orcadUserDataPath: string
): Promise<ElectronSidecarProfile> {
  await removeLeftoverElectronSidecarProfile(orcadUserDataPath)
  const profilePath = join(orcadUserDataPath, PERSISTENT_PROFILE_DIRECTORY)
  if (!(await isUsablePersistentProfile(profilePath))) {
    return { path: await createElectronSidecarProfile(orcadUserDataPath), persistent: false }
  }
  if (!(await stopOrphanedSidecar(profilePath))) {
    // A sidecar that won't answer or exit still locks the profile; its metadata stays to find it later.
    return createTemporaryElectronSidecarProfile(orcadUserDataPath)
  }
  // No sidecar runs here now: a killed one's metadata and Chromium locks would only block the next.
  const cleared = await Promise.all(
    [
      getRuntimeMetadataPath(profilePath),
      ...CHROMIUM_SINGLETON_FILES.map((name) => join(profilePath, name))
    ].map((path) => rm(path, { force: true }))
  ).then(
    () => true,
    () => false
  )
  if (!cleared) {
    return createTemporaryElectronSidecarProfile(orcadUserDataPath)
  }
  return { path: profilePath, persistent: true }
}

async function isUsablePersistentProfile(profilePath: string): Promise<boolean> {
  // Installed apps from before #39972 bind their socket inside the profile with no short-path fallback.
  if (
    process.platform !== 'win32' &&
    !unixSocketPathFits(
      join(profilePath, LONGEST_SIDECAR_SOCKET_NAME),
      process.platform === 'darwin' ? 'darwin' : 'linux'
    )
  ) {
    return false
  }
  try {
    await mkdir(profilePath, { mode: 0o700 })
  } catch (error) {
    if (errnoCodeOrUnknown(error) !== 'EEXIST') {
      return false
    }
  }
  const stats = await lstat(profilePath).catch(() => null)
  if (stats && isSafeOwnedDirectory(stats)) {
    return true
  }
  console.warn(
    '[orcad] Browser profile is not a private directory; using a temporary one:',
    profilePath
  )
  return false
}

/** Unpredictable per start, so no other account can claim the name first. */
async function createElectronSidecarProfile(orcadUserDataPath: string): Promise<string> {
  const profilePath = await mkdtemp(join(temporaryRoot(), PROFILE_PREFIX))
  try {
    await writeFile(join(orcadUserDataPath, PROFILE_RECORD_FILE), JSON.stringify({ profilePath }), {
      mode: 0o600
    })
  } catch (error) {
    await removeTree(profilePath).catch(() => undefined)
    throw error
  }
  return profilePath
}

async function readRecordedProfile(orcadUserDataPath: string): Promise<string | null> {
  try {
    const raw = await readFile(join(orcadUserDataPath, PROFILE_RECORD_FILE), 'utf8')
    const { profilePath } = ProfileRecord.parse(JSON.parse(raw))
    return isDirectChild(temporaryRoot(), profilePath) &&
      basename(profilePath).startsWith(PROFILE_PREFIX)
      ? profilePath
      : null
  } catch {
    return null
  }
}

/** Whether no sidecar is left running on the profile. */
async function stopOrphanedSidecar(profilePath: string): Promise<boolean> {
  const orphan = await readRuntimeMetadataAsync(profilePath).catch(() => null)
  if (!orphan || !isProcessAlive(orphan.pid)) {
    return true
  }
  if (!(await stopAnsweringElectronSidecar(orphan))) {
    // Unverified, so never signalled: it may be a sidecar still quitting, or a recycled pid.
    const deadline = Date.now() + STOP_TIMEOUT_MS
    while (isProcessAlive(orphan.pid) && Date.now() < deadline) {
      await delay(50)
    }
  }
  return !isProcessAlive(orphan.pid)
}

/** Stops the sidecar these metadata name only if it still answers with its own auth token. */
export async function stopAnsweringElectronSidecar(metadata: RuntimeMetadata): Promise<boolean> {
  // Answering proves the pid is still that sidecar, not a recycled one.
  const answered = await sendOrcadSidecarRequest(
    metadata,
    'status.get',
    undefined,
    ORPHAN_PROBE_TIMEOUT_MS
  ).then(
    () => true,
    () => false
  )
  if (answered) {
    await stopElectronSidecar(metadata.pid)
  }
  return answered
}

/** Remove the profile, and any sidecar still on it, that a crashed or killed orcad left behind. */
async function removeLeftoverElectronSidecarProfile(orcadUserDataPath: string): Promise<void> {
  const profilePath = await readRecordedProfile(orcadUserDataPath)
  const stats = profilePath ? await lstat(profilePath).catch(() => null) : null
  if (!profilePath || !stats || !isSafeOwnedDirectory(stats)) {
    return
  }
  await stopOrphanedSidecar(profilePath)
  await removeTree(profilePath).catch((error: unknown) =>
    console.warn('[orcad] Leftover Electron browser sidecar data was not removed:', error)
  )
}
