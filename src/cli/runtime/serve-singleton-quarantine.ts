import { lstat, readdir, readlink, rename, rmdir, symlink, unlink } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { isServeProcessAlive } from './serve-process-liveness'
import {
  createSingletonRecoveryCommitMarker,
  hasCommittedSingletonRecoveryMarker
} from './serve-singleton-recovery-commit'
import {
  restoreExpectedSingletonLock as restoreExpectedLock,
  removeRestoredSingletonBackups,
  restoreSingletonCompanions,
  restoreMovedSingletonLock as restoreMovedLock,
  type MovedSingletonArtifact as MovedArtifact
} from './serve-singleton-lock-restore'

export const SINGLETON_ARTIFACT_NAMES = [
  'SingletonSocket',
  'SingletonCookie',
  'SingletonLock'
] as const

export type SingletonQuarantineResult =
  | { state: 'quarantined'; paths: string[] }
  | { state: 'owner_changed' }
  | { state: 'owner_process_alive' }
  | { state: 'failed'; errorCode?: string; cleanupPaths?: string[] }

type RecoveryGuardFailure = Extract<
  SingletonQuarantineResult,
  { state: 'owner_changed' | 'failed' }
>

const STALE_QUARANTINE_SUFFIX = /^stale-\d+-(\d+)$/
const COMMIT_MARKER_PREFIX = 'SingletonRecoveryCommit.'

export async function reconcileSingletonQuarantines(
  userDataPath: string,
  tempDirectory: string
): Promise<void> {
  await removeAbandonedServeSingletonQuarantines(userDataPath, tempDirectory)
}

export async function removeAbandonedServeSingletonQuarantines(
  userDataPath: string,
  tempDirectory: string,
  isProcessAlive: (pid: number) => boolean = isServeProcessAlive
): Promise<void> {
  const entries = new Set(
    await readdir(userDataPath).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return []
      }
      throw error
    })
  )
  const suffixes = new Set<string>()
  for (const entry of entries) {
    for (const name of [...SINGLETON_ARTIFACT_NAMES, 'SingletonRecoveryCommit']) {
      const prefix = `${name}.`
      if (!entry.startsWith(prefix)) {
        continue
      }
      const suffix = entry.slice(prefix.length)
      const match = STALE_QUARANTINE_SUFFIX.exec(suffix)
      const ownerPid = Number(match?.[1])
      if (match && Number.isSafeInteger(ownerPid) && ownerPid > 0) {
        suffixes.add(suffix)
      }
    }
  }
  for (const suffix of suffixes) {
    const paths = SINGLETON_ARTIFACT_NAMES.map((name) => `${name}.${suffix}`).filter((path) =>
      entries.has(path)
    )
    if (
      !entries.has(COMMIT_MARKER_PREFIX + suffix) ||
      !(await hasCommittedSingletonRecoveryMarker(
        join(userDataPath, COMMIT_MARKER_PREFIX + suffix)
      ))
    ) {
      if (isProcessAlive(Number(STALE_QUARANTINE_SUFFIX.exec(suffix)![1]))) {
        throw new Error(`Unconfirmed singleton backup ${suffix}; recovery is still in progress.`)
      }
      const restored = paths.map((name) => ({
        name,
        source: join(userDataPath, name.slice(0, -suffix.length - 1)),
        target: join(userDataPath, name)
      }))
      if (await removeRestoredSingletonBackups(restored)) {
        continue
      }
      throw new Error(
        `Unconfirmed singleton backup ${suffix}; refusing to discard ownership evidence.`
      )
    }
    if (isProcessAlive(Number(STALE_QUARANTINE_SUFFIX.exec(suffix)![1]))) {
      continue
    }
    paths.push(COMMIT_MARKER_PREFIX + suffix)
    await removeServeSingletonQuarantine(userDataPath, paths, tempDirectory)
  }
}

export async function removeServeSingletonQuarantine(
  userDataPath: string,
  paths: readonly string[],
  tempDirectory?: string
): Promise<void> {
  for (const path of paths) {
    if (
      basename(path) !== path ||
      !(
        SINGLETON_ARTIFACT_NAMES.some((name) => path.startsWith(`${name}.`)) ||
        path.startsWith(COMMIT_MARKER_PREFIX)
      )
    ) {
      throw new Error(`Invalid singleton quarantine path: ${path}`)
    }
  }
  const socketTarget = await readQuarantinedSocketTarget(userDataPath, paths)
  if (socketTarget && tempDirectory) {
    await removeScopedSocketDirectory(socketTarget, tempDirectory)
  }
  const remove = async (path: string): Promise<void> => {
    await unlink(join(userDataPath, path)).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error
      }
    })
  }
  // A failed artifact deletion must retain the evidence that makes a later retry safe.
  await Promise.all(paths.filter((path) => !path.startsWith(COMMIT_MARKER_PREFIX)).map(remove))
  await Promise.all(paths.filter((path) => path.startsWith(COMMIT_MARKER_PREFIX)).map(remove))
}

export async function quarantineSingletonArtifacts(
  userDataPath: string,
  suffix: string,
  expectedLockTarget: string,
  recoveryGuardTarget: string,
  confirmExpectedOwnerDead: () => boolean,
  createGuardLink: (target: string, path: string) => Promise<void> = symlink
): Promise<SingletonQuarantineResult> {
  const lock = {
    source: join(userDataPath, 'SingletonLock'),
    target: join(userDataPath, `SingletonLock.${suffix}`),
    name: 'SingletonLock'
  }
  // Verify the atomically moved lock, then hold the live path with our PID while companions move.
  try {
    // Reusing a suffix would mix this batch with an earlier recovery's commit evidence.
    for (const name of [...SINGLETON_ARTIFACT_NAMES, 'SingletonRecoveryCommit']) {
      const occupied = await lstat(join(userDataPath, `${name}.${suffix}`)).then(
        () => true,
        (error: unknown) => {
          if (quarantineFailure(error).errorCode !== 'ENOENT') {
            throw error
          }
          return false
        }
      )
      if (occupied) {
        return { state: 'failed', errorCode: 'EEXIST' }
      }
    }
    await rename(lock.source, lock.target)
  } catch (error) {
    const errorCode = (error as NodeJS.ErrnoException).code
    return errorCode === 'ENOENT' ? { state: 'owner_changed' } : quarantineFailure(error)
  }

  const movedLockTarget = await readlink(lock.target).catch(() => null)
  if (movedLockTarget !== expectedLockTarget) {
    await restoreMovedLock(lock.source, lock.target, movedLockTarget)
    return { state: 'owner_changed' }
  }

  try {
    await createGuardLink(recoveryGuardTarget, lock.source)
  } catch (error) {
    await restoreMovedLock(lock.source, lock.target, movedLockTarget)
    return (error as NodeJS.ErrnoException).code === 'EEXIST'
      ? { state: 'owner_changed' }
      : quarantineFailure(error)
  }

  if (!confirmExpectedOwnerDead()) {
    await restoreExpectedLock(lock, expectedLockTarget, recoveryGuardTarget)
    return { state: 'owner_process_alive' }
  }

  const moved: MovedArtifact[] = [lock]
  try {
    for (const name of SINGLETON_ARTIFACT_NAMES) {
      if (name === 'SingletonLock') {
        continue
      }
      const source = join(userDataPath, name)
      if (!(await exists(source))) {
        continue
      }
      const target = join(userDataPath, `${name}.${suffix}`)
      await rename(source, target)
      moved.push({ source, target, name })
    }
  } catch (error) {
    await restoreSingletonCompanions(moved.slice(1))
    await restoreExpectedLock(lock, expectedLockTarget, recoveryGuardTarget)
    return quarantineFailure(error)
  }
  if (!confirmExpectedOwnerDead()) {
    await restoreSingletonCompanions(moved.slice(1))
    await restoreExpectedLock(lock, expectedLockTarget, recoveryGuardTarget)
    return { state: 'owner_process_alive' }
  }
  const release = await releaseRecoveryGuard(lock.source, recoveryGuardTarget)
  if (release.failure?.state === 'owner_changed' || (release.failure && !release.cleanupSafe)) {
    return release.failure
  }
  const paths = SINGLETON_ARTIFACT_NAMES.filter((name) =>
    moved.some((entry) => entry.name === name)
  ).map((name) => `${name}.${suffix}`)
  const marker = COMMIT_MARKER_PREFIX + suffix
  try {
    await createSingletonRecoveryCommitMarker(join(userDataPath, marker))
    paths.push(marker)
  } catch (error) {
    return quarantineFailure(error)
  }
  return release.failure
    ? { ...release.failure, cleanupPaths: paths }
    : { state: 'quarantined', paths }
}

async function releaseRecoveryGuard(
  path: string,
  expectedTarget: string
): Promise<{ failure: RecoveryGuardFailure | null; cleanupSafe: boolean }> {
  let target: string
  try {
    target = await readlink(path)
  } catch (error) {
    const absent = (error as NodeJS.ErrnoException).code === 'ENOENT'
    return { failure: absent ? null : quarantineFailure(error), cleanupSafe: absent }
  }
  if (target !== expectedTarget) {
    return { failure: { state: 'owner_changed' }, cleanupSafe: false }
  }
  try {
    await unlink(path)
    return { failure: null, cleanupSafe: true }
  } catch (error) {
    return {
      failure: (error as NodeJS.ErrnoException).code === 'ENOENT' ? null : quarantineFailure(error),
      cleanupSafe: true
    }
  }
}

function quarantineFailure(
  error: unknown
): Extract<SingletonQuarantineResult, { state: 'failed' }> {
  const errorCode = (error as NodeJS.ErrnoException).code
  return { state: 'failed', ...(errorCode ? { errorCode } : {}) }
}

async function readQuarantinedSocketTarget(
  userDataPath: string,
  paths: readonly string[]
): Promise<string | null> {
  const socketPath = paths.find((path) => path.startsWith('SingletonSocket.'))
  if (!socketPath || basename(socketPath) !== socketPath) {
    return null
  }
  return readlink(join(userDataPath, socketPath)).catch(() => null)
}

async function removeScopedSocketDirectory(
  socketTarget: string,
  tempDirectory: string
): Promise<void> {
  if (!isAbsolute(socketTarget) || basename(socketTarget) !== 'SingletonSocket') {
    return
  }
  const scopedDirectory = dirname(resolve(socketTarget))
  const scopedName = basename(scopedDirectory)
  if (
    dirname(scopedDirectory) !== resolve(tempDirectory) ||
    !(/^scoped_dir[A-Za-z0-9]{6}$/.test(scopedName) || scopedName.startsWith('.org.chromium.'))
  ) {
    return
  }
  const stats = await lstat(scopedDirectory).catch(() => null)
  if (!stats?.isDirectory() || (process.getuid && stats.uid !== process.getuid())) {
    return
  }
  await unlink(socketTarget).catch((error) => {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error
    }
  })
  const cookiePath = join(scopedDirectory, 'SingletonCookie')
  const cookieStats = await lstat(cookiePath).catch(() => null)
  if (cookieStats?.isSymbolicLink()) {
    await unlink(cookiePath)
  }
  await rmdir(scopedDirectory).catch((error) => {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'ENOENT' && code !== 'ENOTEMPTY') {
      throw error
    }
  })
}

async function exists(path: string): Promise<boolean> {
  return await lstat(path).then(
    () => true,
    () => false
  )
}
