import { lstat, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  removeAbandonedServeSingletonQuarantines,
  SINGLETON_ARTIFACT_NAMES
} from './serve-singleton-quarantine'

async function pathExists(path: string): Promise<boolean> {
  return lstat(path).then(
    () => true,
    () => false
  )
}

describe.skipIf(process.platform === 'win32')('serve singleton quarantine cleanup', () => {
  const roots: string[] = []

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
  })

  it('reconstructs dead recovery paths while preserving live and malformed suffixes', async () => {
    const userDataPath = await mkdtemp(join(tmpdir(), 'orca-quarantine-profile-'))
    const tempDirectory = await mkdtemp(join(tmpdir(), 'orca-quarantine-temp-'))
    roots.push(userDataPath, tempDirectory)
    const deadSuffix = 'stale-1000-4101'
    const liveSuffix = 'stale-1001-4102'
    const scopedDirectory = join(tempDirectory, 'scoped_dirABC123')
    const socketTarget = join(scopedDirectory, 'SingletonSocket')
    await mkdir(scopedDirectory)
    await writeFile(socketTarget, 'stale socket')
    await symlink('stale-cookie', join(scopedDirectory, 'SingletonCookie'))

    for (const name of SINGLETON_ARTIFACT_NAMES) {
      await symlink(
        name === 'SingletonSocket' ? socketTarget : `dead-${name}`,
        join(userDataPath, `${name}.${deadSuffix}`)
      )
      await symlink(`live-${name}`, join(userDataPath, `${name}.${liveSuffix}`))
    }
    await symlink('unrelated', join(userDataPath, 'SingletonLock.stale-invalid'))

    await removeAbandonedServeSingletonQuarantines(
      userDataPath,
      tempDirectory,
      (pid) => pid === 4102
    )

    for (const name of SINGLETON_ARTIFACT_NAMES) {
      expect(await pathExists(join(userDataPath, `${name}.${deadSuffix}`))).toBe(false)
      expect(await pathExists(join(userDataPath, `${name}.${liveSuffix}`))).toBe(true)
    }
    expect(await pathExists(scopedDirectory)).toBe(false)
    expect(await pathExists(join(userDataPath, 'SingletonLock.stale-invalid'))).toBe(true)
  })

  it('treats a missing profile as already reconciled', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-quarantine-missing-'))
    roots.push(root)

    await expect(
      removeAbandonedServeSingletonQuarantines(join(root, 'missing'), root, () => false)
    ).resolves.toBeUndefined()
  })
})
