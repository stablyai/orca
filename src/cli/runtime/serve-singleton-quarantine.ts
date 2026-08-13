import { link, lstat, readlink, rename, symlink, unlink } from 'node:fs/promises'
import { basename, join } from 'node:path'

export const SINGLETON_ARTIFACT_NAMES = [
  'SingletonSocket',
  'SingletonCookie',
  'SingletonLock'
] as const

export type SingletonQuarantineResult =
  | { state: 'quarantined'; paths: string[] }
  | { state: 'owner_changed' }
  | { state: 'failed' }

type MovedArtifact = { source: string; target: string; name: string }

export async function removeServeSingletonQuarantine(
  userDataPath: string,
  paths: readonly string[]
): Promise<void> {
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
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? { state: 'owner_changed' }
      : { state: 'failed' }
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
      : { state: 'failed' }
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
  } catch {
    for (const entry of moved.slice(1).toReversed()) {
      await rename(entry.target, entry.source).catch(() => undefined)
    }
    await restoreExpectedLock(lock, expectedLockTarget, recoveryGuardTarget)
    return { state: 'failed' }
  } finally {
    if ((await readlink(lock.source).catch(() => null)) === recoveryGuardTarget) {
      await unlink(lock.source).catch(() => undefined)
    }
  }
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
