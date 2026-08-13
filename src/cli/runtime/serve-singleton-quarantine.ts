import { link, lstat, readlink, rename, rmdir, symlink, unlink } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'

export const SINGLETON_ARTIFACT_NAMES = [
  'SingletonSocket',
  'SingletonCookie',
  'SingletonLock'
] as const

export type SingletonQuarantineResult =
  | { state: 'quarantined'; paths: string[] }
  | { state: 'owner_changed' }
  | { state: 'failed'; errorCode?: string }

type MovedArtifact = { source: string; target: string; name: string }

export async function removeServeSingletonQuarantine(
  userDataPath: string,
  paths: readonly string[],
  tempDirectory?: string
): Promise<void> {
  const socketTarget = await readQuarantinedSocketTarget(userDataPath, paths)
  if (socketTarget && tempDirectory) {
    await removeScopedSocketDirectory(socketTarget, tempDirectory)
  }
  await Promise.all(
    paths.map(async (path) => {
      if (
        basename(path) !== path ||
        !SINGLETON_ARTIFACT_NAMES.some((name) => path.startsWith(`${name}.`))
      ) {
        throw new Error(`Invalid singleton quarantine path: ${path}`)
      }
      await unlink(join(userDataPath, path)).catch((error) => {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw error
        }
      })
    })
  )
}

export async function quarantineSingletonArtifacts(
  userDataPath: string,
  suffix: string,
  expectedLockTarget: string,
  recoveryGuardTarget: string,
  createGuardLink: (target: string, path: string) => Promise<void> = symlink
): Promise<SingletonQuarantineResult> {
  const lock = {
    source: join(userDataPath, 'SingletonLock'),
    target: join(userDataPath, `SingletonLock.${suffix}`),
    name: 'SingletonLock'
  }
  // Verify the atomically moved lock, then hold the live path with our PID while companions move.
  try {
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
    const movedNames = new Set(moved.map(({ name }) => name))
    return {
      state: 'quarantined',
      paths: SINGLETON_ARTIFACT_NAMES.filter((name) => movedNames.has(name)).map(
        (name) => `${name}.${suffix}`
      )
    }
  } catch (error) {
    for (const entry of moved.slice(1).toReversed()) {
      await rename(entry.target, entry.source).catch(() => undefined)
    }
    await restoreExpectedLock(lock, expectedLockTarget, recoveryGuardTarget)
    return quarantineFailure(error)
  } finally {
    if ((await readlink(lock.source).catch(() => null)) === recoveryGuardTarget) {
      await unlink(lock.source).catch(() => undefined)
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

async function restoreExpectedLock(
  lock: MovedArtifact,
  expectedLockTarget: string,
  recoveryGuardTarget: string
): Promise<void> {
  if ((await readlink(lock.source).catch(() => null)) !== recoveryGuardTarget) {
    return
  }
  await unlink(lock.source).catch(() => undefined)
  await restoreMovedLock(lock.source, lock.target, expectedLockTarget)
}

async function restoreMovedLock(
  source: string,
  target: string,
  movedLockTarget: string | null
): Promise<void> {
  try {
    // Hard-linking restores an unreadable entry without overwriting a concurrent owner.
    await (movedLockTarget ? symlink(movedLockTarget, source) : link(target, source))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      return
    }
  }
  await unlink(target).catch(() => undefined)
}

async function exists(path: string): Promise<boolean> {
  return await lstat(path).then(
    () => true,
    () => false
  )
}
