import { randomUUID } from 'node:crypto'
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  realpathSync,
  rmdirSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { hostname } from 'node:os'
import { dirname, join } from 'node:path'
import { bestEffortFsyncDirectorySync, fsyncFileSync } from '../../../shared/secure-file'
import { renameFileWithWindowsRetry } from '../../codex-accounts/fs-utils'
import {
  START_TIME_TOLERANCE_MS,
  startTimesWithinTolerance
} from '../../daemon/daemon-process-start-time'
import {
  profileStateAccessBootIdentity,
  profileStateAccessMachineIdentity,
  profileStateAccessProcessIdentity
} from './profile-state-access-identity'

export class ProfileStateAccessError extends Error {
  readonly code = 'profile-state-access-refused' as const

  constructor(message: string) {
    super(message)
    this.name = 'ProfileStateAccessError'
  }
}

export type ProfileStateAccessPaths = ReturnType<typeof profileStateAccessPaths>

export function profileStateAccessPaths(userDataPath: string) {
  mkdirSync(userDataPath, { recursive: true, mode: 0o700 })
  const root = join(realpathSync(userDataPath), '.profile-state-access')
  const paths = {
    root,
    participants: join(root, 'participants'),
    candidates: join(root, 'candidates'),
    maintenance: join(root, 'maintenance')
  }
  for (const path of [root, paths.participants, paths.candidates]) {
    mkdirSync(path, { recursive: true, mode: 0o700 })
  }
  return paths
}

export const PROFILE_STATE_ACCESS_TOKEN = /^[a-f0-9-]{36}$/

type AccessOwner = {
  token: string
  pid: number
  host: string
  platform: string
  pidNamespace: string | null
  bootIdentity?: string | null
  machineIdentity?: string | null
  processStartIdentity?: string | null
}

export function profileStateAccessPidNamespace(): string | null {
  if (process.platform !== 'linux') {
    return null
  }
  try {
    return readlinkSync('/proc/self/ns/pid')
  } catch {
    return null
  }
}

function readOwner(path: string): AccessOwner | undefined {
  try {
    if (!lstatSync(path).isFile()) {
      throw new ProfileStateAccessError(`Profile state owner is not a regular file: ${path}`)
    }
    const owner: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (
      typeof owner === 'object' &&
      owner !== null &&
      'token' in owner &&
      typeof owner.token === 'string' &&
      PROFILE_STATE_ACCESS_TOKEN.test(owner.token) &&
      'pid' in owner &&
      typeof owner.pid === 'number' &&
      Number.isSafeInteger(owner.pid) &&
      owner.pid > 0 &&
      'host' in owner &&
      typeof owner.host === 'string' &&
      owner.host.length > 0 &&
      'platform' in owner &&
      typeof owner.platform === 'string' &&
      'pidNamespace' in owner &&
      (owner.pidNamespace === null || typeof owner.pidNamespace === 'string')
    ) {
      return {
        token: owner.token,
        pid: owner.pid,
        host: owner.host,
        platform: owner.platform,
        pidNamespace: owner.pidNamespace,
        bootIdentity:
          'bootIdentity' in owner && typeof owner.bootIdentity === 'string'
            ? owner.bootIdentity
            : null,
        machineIdentity:
          'machineIdentity' in owner && typeof owner.machineIdentity === 'string'
            ? owner.machineIdentity
            : null,
        processStartIdentity:
          'processStartIdentity' in owner &&
          typeof owner.processStartIdentity === 'string' &&
          /^(?:linux-start-ticks|darwin-utc-start-ms|wall-time-ms):\d+$/.test(
            owner.processStartIdentity
          ) &&
          Number.isSafeInteger(Number(owner.processStartIdentity.split(':')[1]))
            ? owner.processStartIdentity
            : null
      }
    }
  } catch (error) {
    if (hasCode(error, 'ENOENT')) {
      return undefined
    }
    throw new ProfileStateAccessError(`Profile state ownership is unverifiable: ${path}`)
  }
  throw new ProfileStateAccessError(`Profile state ownership is malformed: ${path}`)
}

function ownerExited(owner: AccessOwner): boolean {
  const currentBoot = profileStateAccessBootIdentity()
  const currentMachine = profileStateAccessMachineIdentity()
  const sameBoot = Boolean(owner.bootIdentity && owner.bootIdentity === currentBoot)
  const sameMachine = Boolean(owner.machineIdentity && owner.machineIdentity === currentMachine)
  const sameHost = owner.host === hostname()
  if (
    (!sameBoot && !sameHost) ||
    owner.platform !== process.platform ||
    (!sameBoot && owner.machineIdentity && currentMachine && !sameMachine)
  ) {
    return false
  }
  if (
    sameHost &&
    sameMachine &&
    owner.bootIdentity &&
    currentBoot &&
    owner.bootIdentity !== currentBoot
  ) {
    return true
  }
  // Windows/WSL and Linux PID namespaces cannot establish each other's process absence.
  if (
    process.platform === 'linux' &&
    (owner.pidNamespace === null || owner.pidNamespace !== profileStateAccessPidNamespace())
  ) {
    return false
  }
  try {
    process.kill(owner.pid, 0)
  } catch (error) {
    return hasCode(error, 'ESRCH')
  }
  const recordedStart = owner.processStartIdentity
  const actualStart =
    !sameBoot || recordedStart == null ? null : profileStateAccessProcessIdentity(owner.pid)
  return (
    actualStart !== null &&
    recordedStart != null &&
    actualStart.split(':')[0] === recordedStart.split(':')[0] &&
    (actualStart.startsWith('darwin-utc-start-ms:')
      ? !startTimesWithinTolerance(
          Number(actualStart.split(':')[1]),
          Number(recordedStart.split(':')[1]),
          START_TIME_TOLERANCE_MS
        )
      : actualStart !== recordedStart)
  )
}

export function hasCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code
}

export function removeOwnerEntry(path: string): void {
  try {
    unlinkSync(path)
  } catch (error) {
    if (!hasCode(error, 'ENOENT')) {
      throw error
    }
  }
}

function removeEmptyOwnerDirectory(path: string): void {
  try {
    rmdirSync(path)
  } catch (error) {
    if (!['ENOENT', 'ENOTEMPTY', 'EEXIST', 'EBUSY'].some((code) => hasCode(error, code))) {
      throw error
    }
  }
}

/** Only remove immutable entries whose owner is positively known to have exited. */
export function reclaimExitedOwner(path: string): void {
  let entries: string[]
  try {
    if (!lstatSync(path).isDirectory()) {
      throw new ProfileStateAccessError(`Profile state owner is not a directory: ${path}`)
    }
    entries = readdirSync(path)
  } catch (error) {
    if (hasCode(error, 'ENOENT')) {
      return
    }
    throw error
  }
  for (const entry of entries) {
    const token = entry.endsWith('.owner') ? entry.slice(0, -6) : ''
    if (!PROFILE_STATE_ACCESS_TOKEN.test(token)) {
      throw new ProfileStateAccessError(`Profile state ownership is unverifiable: ${path}`)
    }
    const owner = readOwner(join(path, entry))
    if (owner === undefined) {
      continue
    }
    if (owner.token !== token || !ownerExited(owner)) {
      throw new ProfileStateAccessError(
        `Profile state is in use or its owner is unverifiable: ${path}. Stop Orca and orcad on every host using this profile, then retry. If this remains, verify PID ${owner.pid} on ${owner.host} has exited before removing its owner entry ${join(path, entry)}.`
      )
    }
    removeOwnerEntry(join(path, entry))
  }
  // A replacement owner keeps the directory nonempty, even if our observation is stale.
  removeEmptyOwnerDirectory(path)
}

export function publishAccessOwner(paths: ProfileStateAccessPaths, exclusive: boolean) {
  const token = randomUUID()
  const candidate = join(paths.candidates, token)
  const target = exclusive ? paths.maintenance : join(paths.participants, token)
  const entry = `${token}.owner`
  mkdirSync(candidate, { mode: 0o700 })
  let published = false
  try {
    writeFileSync(
      join(candidate, entry),
      JSON.stringify({
        token,
        pid: process.pid,
        host: hostname(),
        platform: process.platform,
        pidNamespace: profileStateAccessPidNamespace(),
        bootIdentity: profileStateAccessBootIdentity(),
        machineIdentity: profileStateAccessMachineIdentity(),
        processStartIdentity: profileStateAccessProcessIdentity(process.pid)
      }),
      {
        flag: 'wx',
        mode: 0o600
      }
    )
    fsyncFileSync(join(candidate, entry))
    bestEffortFsyncDirectorySync(candidate)
    for (let attempt = 0; ; attempt += 1) {
      try {
        renameFileWithWindowsRetry(candidate, target)
        published = true
        break
      } catch (error) {
        if (!exclusive || attempt >= 2) {
          throw error
        }
        reclaimExitedOwner(target)
      }
    }
    bestEffortFsyncDirectorySync(dirname(target))
    bestEffortFsyncDirectorySync(paths.candidates)
  } catch (error) {
    if (published) {
      removeOwnerEntry(join(target, entry))
      removeEmptyOwnerDirectory(target)
    }
    throw error
  } finally {
    if (!published) {
      removeOwnerEntry(join(candidate, entry))
      removeEmptyOwnerDirectory(candidate)
    }
  }
  let released = false
  return {
    token,
    assertActive(): void {
      if (released || readOwner(join(target, entry))?.token !== token) {
        throw new ProfileStateAccessError('Profile state access has already been released')
      }
    },
    release(): void {
      if (released) {
        return
      }
      removeOwnerEntry(join(target, entry))
      removeEmptyOwnerDirectory(target)
      released = true
    }
  }
}
