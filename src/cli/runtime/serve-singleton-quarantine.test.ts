import { link, lstat, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type * as Filesystem from 'node:fs/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  removeAbandonedServeSingletonQuarantines,
  SINGLETON_ARTIFACT_NAMES
} from './serve-singleton-quarantine'
import { prepareLinuxServeSupervision } from './serve-linux-supervision-startup'

const cleanupFault = vi.hoisted(() => ({
  path: '',
  remaining: 0,
  readlinkPath: '',
  readlinkCode: 'EACCES',
  markerFlight: null as Promise<void> | null
}))
vi.mock('node:fs/promises', async (importOriginal) => {
  const filesystem = await importOriginal<typeof Filesystem>()
  return {
    ...filesystem,
    readlink: async (...args: Parameters<typeof filesystem.readlink>) => {
      if (String(args[0]) === cleanupFault.readlinkPath) {
        if (cleanupFault.readlinkCode === 'ENOENT') {
          await filesystem.unlink(String(args[0]))
        }
        throw Object.assign(new Error('canonical target unreadable'), {
          code: cleanupFault.readlinkCode
        })
      }
      return filesystem.readlink(...args)
    },
    unlink: (...args: Parameters<typeof filesystem.unlink>) => {
      if (String(args[0]) === cleanupFault.path && cleanupFault.remaining > 0) {
        cleanupFault.remaining -= 1
        return Promise.reject(
          Object.assign(new Error('artifact cleanup failed'), { code: 'EPERM' })
        )
      }
      const result = filesystem.unlink(...args)
      if (String(args[0]).includes('SingletonRecoveryCommit.')) {
        cleanupFault.markerFlight = result
      }
      return result
    }
  }
})

async function pathExists(path: string): Promise<boolean> {
  return lstat(path).then(
    () => true,
    () => false
  )
}

describe.skipIf(process.platform === 'win32')('serve singleton quarantine cleanup', () => {
  const roots: string[] = []

  afterEach(async () => {
    cleanupFault.path = ''
    cleanupFault.remaining = 0
    cleanupFault.readlinkPath = ''
    cleanupFault.readlinkCode = 'EACCES'
    cleanupFault.markerFlight = null
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
    await symlink(
      'orca-singleton-recovery-commit-v1',
      join(userDataPath, `SingletonRecoveryCommit.${deadSuffix}`)
    )
    await symlink(
      'orca-singleton-recovery-commit-v1',
      join(userDataPath, `SingletonRecoveryCommit.${liveSuffix}`)
    )

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
    expect(await pathExists(join(userDataPath, `SingletonRecoveryCommit.${deadSuffix}`))).toBe(
      false
    )
  })

  it('retains the commit marker after failed cleanup so a later startup can retry', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-quarantine-retry-'))
    roots.push(root)
    const suffix = 'stale-1000-2147483647'
    const marker = join(root, `SingletonRecoveryCommit.${suffix}`)
    const artifact = join(root, `SingletonLock.${suffix}`)
    await symlink('dead-owner', artifact)
    await symlink('orca-singleton-recovery-commit-v1', marker)
    cleanupFault.path = artifact
    cleanupFault.remaining = 1

    await expect(prepareLinuxServeSupervision(root, root, {})).rejects.toMatchObject({
      code: 'EPERM'
    })
    await cleanupFault.markerFlight
    expect(await pathExists(marker)).toBe(true)
    expect(await pathExists(artifact)).toBe(true)
    const childEnv: NodeJS.ProcessEnv = {}
    await expect(prepareLinuxServeSupervision(root, root, childEnv)).resolves.toBeUndefined()
    expect(childEnv.ORCA_SERVE_SUPERVISED).toBe('1')
    expect(await pathExists(artifact)).toBe(false)
    expect(await pathExists(marker)).toBe(false)
  })

  it.each(['missing', 'changed', 'unreadable', 'recoverer-alive'])(
    'preserves unconfirmed ownership evidence when canonical state is %s',
    async (state) => {
      const root = await mkdtemp(join(tmpdir(), 'orca-quarantine-pending-'))
      roots.push(root)
      const pid = state === 'recoverer-alive' ? process.pid : 2147483647
      const backup = join(root, `SingletonLock.stale-1000-${pid}`)
      const canonical = join(root, 'SingletonLock')
      await symlink('original-owner', backup)
      if (state !== 'missing') {
        await symlink(state === 'changed' ? 'foreign-owner' : 'original-owner', canonical)
      }
      if (state === 'unreadable') {
        cleanupFault.readlinkPath = canonical
      }
      const childEnv: NodeJS.ProcessEnv = {}

      await expect(prepareLinuxServeSupervision(root, root, childEnv)).rejects.toThrow(
        'Unconfirmed singleton backup'
      )
      expect(await pathExists(backup)).toBe(true)
      expect(await pathExists(canonical)).toBe(state !== 'missing')
      expect(childEnv.ORCA_SERVE_SUPERVISED).toBeUndefined()
    }
  )

  it.each(['legacy-file', 'directory', 'foreign-target', 'unreadable', 'vanished'])(
    'preserves dead-recoverer backups with an unconfirmed %s marker',
    async (kind) => {
      const root = await mkdtemp(join(tmpdir(), 'orca-quarantine-unconfirmed-marker-'))
      roots.push(root)
      const suffix = 'stale-1000-2147483647'
      const backup = join(root, `SingletonLock.${suffix}`)
      const marker = join(root, `SingletonRecoveryCommit.${suffix}`)
      await symlink('original-owner', backup)
      if (kind === 'legacy-file') {
        await writeFile(marker, '')
      } else if (kind === 'directory') {
        await mkdir(marker)
      } else {
        await symlink(
          kind === 'foreign-target' ? 'foreign-commit-target' : 'orca-singleton-recovery-commit-v1',
          marker
        )
      }
      if (kind === 'unreadable' || kind === 'vanished') {
        cleanupFault.readlinkPath = marker
        cleanupFault.readlinkCode = kind === 'vanished' ? 'ENOENT' : 'EACCES'
      }
      const retained = (await readdir(root)).sort()
      const childEnv: NodeJS.ProcessEnv = {}

      const scan = removeAbandonedServeSingletonQuarantines(root, root, () => false)
      if (kind === 'unreadable') {
        await expect(scan).rejects.toMatchObject({ code: 'EACCES' })
        await expect(prepareLinuxServeSupervision(root, root, childEnv)).rejects.toMatchObject({
          code: 'EACCES'
        })
      } else {
        await expect(scan).rejects.toThrow('refusing to discard ownership evidence')
        await expect(prepareLinuxServeSupervision(root, root, childEnv)).rejects.toThrow(
          'refusing to discard ownership evidence'
        )
      }
      expect(childEnv.ORCA_SERVE_SUPERVISED).toBeUndefined()
      expect(await pathExists(backup)).toBe(true)
      expect(await pathExists(marker)).toBe(kind !== 'vanished')
      expect((await readdir(root)).sort()).toEqual(
        kind === 'vanished'
          ? retained.filter((entry) => !entry.startsWith('SingletonRecoveryCommit.'))
          : retained
      )
    }
  )

  it('removes restored socket duplicates without removing their live scoped directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-quarantine-restored-'))
    roots.push(root)
    const scopedDirectory = join(root, 'scoped_dirABC123')
    await mkdir(scopedDirectory)
    const socketTarget = join(scopedDirectory, 'SingletonSocket')
    await writeFile(socketTarget, 'live socket')
    await symlink('live-cookie', join(scopedDirectory, 'SingletonCookie'))
    const backup = join(root, 'SingletonSocket.stale-1000-2147483647')
    await symlink(socketTarget, join(root, 'SingletonSocket'))
    await symlink(socketTarget, backup)

    await expect(prepareLinuxServeSupervision(root, root, {})).resolves.toBeUndefined()
    expect(await pathExists(backup)).toBe(false)
    expect(await pathExists(socketTarget)).toBe(true)
    expect(await pathExists(join(scopedDirectory, 'SingletonCookie'))).toBe(true)
  })

  it('preserves the whole unconfirmed batch when only an earlier artifact matches', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-quarantine-mixed-'))
    roots.push(root)
    const suffix = 'stale-1000-2147483647'
    await symlink('same-socket', join(root, 'SingletonSocket'))
    await symlink('same-socket', join(root, `SingletonSocket.${suffix}`))
    await symlink('foreign-owner', join(root, 'SingletonLock'))
    await symlink('original-owner', join(root, `SingletonLock.${suffix}`))

    await expect(prepareLinuxServeSupervision(root, root, {})).rejects.toThrow(
      'Unconfirmed singleton backup'
    )
    expect(await pathExists(join(root, `SingletonSocket.${suffix}`))).toBe(true)
    expect(await pathExists(join(root, `SingletonLock.${suffix}`))).toBe(true)
  })

  it('removes only a hardlinked backup of a restored companion', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-quarantine-hardlink-'))
    roots.push(root)
    const source = join(root, 'SingletonCookie')
    const backup = join(root, 'SingletonCookie.stale-1000-2147483647')
    await writeFile(backup, 'live-cookie')
    await link(backup, source)

    await expect(prepareLinuxServeSupervision(root, root, {})).resolves.toBeUndefined()
    expect(await pathExists(source)).toBe(true)
    expect(await pathExists(backup)).toBe(false)
  })

  it('treats a missing profile as already reconciled', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-quarantine-missing-'))
    roots.push(root)

    await expect(
      removeAbandonedServeSingletonQuarantines(join(root, 'missing'), root, () => false)
    ).resolves.toBeUndefined()
  })
})
