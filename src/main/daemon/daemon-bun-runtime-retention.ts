import { randomUUID } from 'node:crypto'
import { lstat, readdir, realpath, rename, rm } from 'node:fs/promises'
import { join, win32 } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import {
  acquireProfileStateMaintenance,
  acquireProfileStateRuntimeAdmission,
  ProfileStateAccessError,
  type ProfileStateRuntimeAdmission
} from '../persistence/profile-state/profile-state-access'
import {
  isWindowsProcessStartTimeAvailable,
  isWindowsProcessTableAvailable,
  readWindowsProcessTableFresh,
  type WindowsProcessRow
} from '../windows/windows-process-table'

export const MANAGED_DAEMON_RUNTIME_DIRECTORY = 'managed-v1'
const GENERATION = /^bun-[a-f0-9]{64}(?:\.repair-[1-9][0-9]*)?$/u
const STAGING = /^\.bun-staging-[a-f0-9-]{36}$/u
const TRASH = /^\.bun-trash-[a-f0-9-]{36}$/u
const RETAIN_UNUSED = 2
const DELETE_LIMIT = 4

/** The profile admission protocol also provides host-wide shared/exclusive process ownership. */
export async function acquireDaemonRuntimeLaunchPin(
  root: string
): Promise<ProfileStateRuntimeAdmission> {
  for (let attempt = 0; ; attempt++) {
    try {
      return acquireProfileStateRuntimeAdmission(root)
    } catch (error) {
      if (!(error instanceof ProfileStateAccessError) || attempt >= 30) {
        throw error
      }
      await delay(100)
    }
  }
}

function normalized(path: string): string {
  return path.replaceAll('/', '\\').toLowerCase()
}

/** Unknown image paths veto removal; a basename alone cannot locate a loaded runtime. */
export async function collectPinnedDaemonRuntimeDirectories(
  rows: WindowsProcessRow[],
  directories: string[],
  resolveExecutablePath: (path: string) => Promise<string> = realpath
): Promise<Set<string> | null> {
  const pinned = new Set<string>()
  const canonicalImages = new Map<string, string | null>()
  for (const row of rows) {
    if (!/^(?:bun(?:-runtime)?|openconsole)\.exe$/iu.test(row.name)) {
      continue
    }
    if (!row.creationTimeMs || !Number.isSafeInteger(row.creationTimeMs) || !row.command) {
      return null
    }
    const executable = row.command.startsWith('"')
      ? /^"([^"\r\n]+)"/u.exec(row.command)?.[1]
      : /^([^\s"]+)/u.exec(row.command)?.[1]
    if (
      !executable ||
      !win32.isAbsolute(executable) ||
      !/^(?:[a-z]:\\|\\\\)/iu.test(normalized(executable))
    ) {
      return null
    }
    let canonicalExecutable: string
    try {
      canonicalExecutable = normalized(await resolveExecutablePath(executable))
    } catch {
      return null
    }
    const command = normalized(row.command)
    for (const directory of directories) {
      const prefix = `${normalized(directory)}\\`
      if (canonicalExecutable.startsWith(prefix) || command.includes(prefix)) {
        pinned.add(directory)
        continue
      }
      const image =
        row.name.toLowerCase() === 'openconsole.exe'
          ? join(directory, 'conpty', 'OpenConsole.exe')
          : join(directory, 'bun-runtime.exe')
      let canonicalImage = canonicalImages.get(image)
      if (canonicalImage === undefined) {
        try {
          canonicalImage = normalized(await resolveExecutablePath(image))
          canonicalImages.set(image, canonicalImage)
        } catch (error) {
          // Staging and retired trees may lack images; unknown published identities veto deletion.
          if (
            (!STAGING.test(win32.basename(directory)) && !TRASH.test(win32.basename(directory))) ||
            !(error instanceof Error) ||
            !('code' in error) ||
            error.code !== 'ENOENT'
          ) {
            return null
          }
          canonicalImage = null
          canonicalImages.set(image, null)
        }
      }
      if (canonicalImage === canonicalExecutable) {
        pinned.add(directory)
      }
    }
  }
  return pinned
}

/** Only this namespace participates in launch pins; older runtimes are never candidates. */
export async function pruneDaemonBunRuntimes(hostRoot: string): Promise<void> {
  if (!isWindowsProcessTableAvailable() || !isWindowsProcessStartTimeAvailable()) {
    return
  }
  const requestedRoot = join(hostRoot, MANAGED_DAEMON_RUNTIME_DIRECTORY)
  const retired: string[] = []
  let admission: ProfileStateRuntimeAdmission | undefined
  try {
    if ((await lstat(requestedRoot)).isSymbolicLink()) {
      return
    }
    const root = await realpath(requestedRoot)
    admission = acquireProfileStateMaintenance(root)
    const candidates: { path: string; modified: number; staging: boolean }[] = []
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (
        !entry.isDirectory() ||
        (!GENERATION.test(entry.name) && !STAGING.test(entry.name) && !TRASH.test(entry.name))
      ) {
        continue
      }
      const path = join(root, entry.name)
      const stat = await lstat(path)
      if (!stat.isDirectory() || stat.isSymbolicLink() || (await realpath(path)) !== path) {
        continue
      }
      candidates.push({
        path,
        modified: stat.mtimeMs,
        staging: STAGING.test(entry.name) || TRASH.test(entry.name)
      })
    }
    const pinned = await collectPinnedDaemonRuntimeDirectories(
      await readWindowsProcessTableFresh(),
      candidates.map(({ path }) => path)
    )
    if (!pinned) {
      return
    }
    const unused = candidates
      .filter(({ path, staging }) => !staging && !pinned.has(path))
      .sort((a, b) => b.modified - a.modified)
      .slice(RETAIN_UNUSED)
    const abandonedStaging = candidates.filter(({ path, staging }) => staging && !pinned.has(path))
    for (const candidate of [...abandonedStaging, ...unused].slice(0, DELETE_LIMIT)) {
      admission.assertActive()
      if ((await lstat(candidate.path)).isSymbolicLink()) {
        continue
      }
      const trash = join(root, `.bun-trash-${randomUUID()}`)
      await rename(candidate.path, trash)
      retired.push(trash)
    }
  } catch {
    // Retention is optional; missing identity, busy admissions and disk errors preserve files.
  } finally {
    try {
      admission?.release()
    } catch (error) {
      console.warn('[daemon] Could not release runtime retention ownership', error)
    }
  }
  // Detached names cannot be launched; slow antivirus deletion must not block launch pins.
  for (const path of retired) {
    await rm(path, { recursive: true, force: true }).catch(() => {})
  }
}

const pendingPrunes = new Set<string>()
export function scheduleDaemonBunRuntimePrune(hostRoot: string): void {
  if (pendingPrunes.has(hostRoot)) {
    return
  }
  pendingPrunes.add(hostRoot)
  const timer = setTimeout(() => {
    void pruneDaemonBunRuntimes(hostRoot).finally(() => pendingPrunes.delete(hostRoot))
  }, 0)
  timer.unref()
}
