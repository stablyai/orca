import { EventEmitter } from 'node:events'
import { readlinkSync } from 'node:fs'
import { mkdtemp, readdir, rm, symlink } from 'node:fs/promises'
import type * as Filesystem from 'node:fs/promises'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  SERVE_ALREADY_RUNNING_EXIT_CODE,
  SERVE_SUPERVISOR_STOP_EXIT_CODE
} from '../../shared/serve-supervision'
import {
  recoverStaleServeSingleton,
  type ServeSingletonRecoveryResult
} from './serve-singleton-recovery'
import { superviseForegroundServe } from './serve-update-supervisor'
import {
  removeAbandonedServeSingletonQuarantines,
  removeServeSingletonQuarantine
} from './serve-singleton-quarantine'
import { prepareLinuxServeSupervision } from './serve-linux-supervision-startup'

const guardFault = vi.hoisted(() => ({
  path: '',
  companionPath: '',
  armed: false,
  unlinkCode: null as string | null,
  unlinkFailuresRemaining: null as number | null,
  readlinkCode: null as string | null,
  renameCode: null as string | null,
  afterMove: null as 'remove' | 'replace' | null,
  replacementTarget: '',
  backupPath: '',
  backupUnlinkFailures: 0,
  markerPath: '',
  markerCode: null as string | null,
  markerCreatedBeforeFailure: false,
  statPath: '',
  statCode: null as string | null
}))

vi.mock('./serve-runtime-health', () => ({ probeServeRuntimeHealth: vi.fn() }))

vi.mock('node:fs/promises', async (importOriginal) => {
  const filesystem = await importOriginal<typeof Filesystem>()
  return {
    ...filesystem,
    lstat: (...args: Parameters<typeof filesystem.lstat>) => {
      if (String(args[0]) === guardFault.statPath && guardFault.statCode) {
        return Promise.reject(
          Object.assign(new Error('quarantine destination unreadable'), {
            code: guardFault.statCode
          })
        )
      }
      return filesystem.lstat(...args)
    },
    symlink: async (...args: Parameters<typeof filesystem.symlink>) => {
      if (String(args[1]) === guardFault.markerPath && guardFault.markerCode) {
        if (guardFault.markerCreatedBeforeFailure) {
          await filesystem.symlink(...args)
        }
        throw Object.assign(new Error('recovery commit marker creation failed'), {
          code: guardFault.markerCode
        })
      }
      return filesystem.symlink(...args)
    },
    unlink: async (...args: Parameters<typeof filesystem.unlink>) => {
      if (String(args[0]) === guardFault.backupPath && guardFault.backupUnlinkFailures > 0) {
        guardFault.backupUnlinkFailures -= 1
        throw Object.assign(new Error('backup unlink failed'), { code: 'EPERM' })
      }
      if (
        guardFault.armed &&
        String(args[0]) === guardFault.path &&
        guardFault.unlinkCode &&
        guardFault.unlinkFailuresRemaining !== 0
      ) {
        if (guardFault.unlinkFailuresRemaining !== null) {
          guardFault.unlinkFailuresRemaining -= 1
        }
        if (guardFault.unlinkCode === 'ENOENT') {
          await filesystem.unlink(...args)
        }
        throw Object.assign(new Error('guard unlink failed'), { code: guardFault.unlinkCode })
      }
      return filesystem.unlink(...args)
    },
    readlink: (...args: Parameters<typeof filesystem.readlink>) => {
      if (guardFault.armed && String(args[0]) === guardFault.path && guardFault.readlinkCode) {
        return Promise.reject(
          Object.assign(new Error('guard readlink failed'), { code: guardFault.readlinkCode })
        )
      }
      return filesystem.readlink(...args)
    },
    rename: async (...args: Parameters<typeof filesystem.rename>) => {
      const movingCompanion = String(args[0]) === guardFault.companionPath
      if (movingCompanion && guardFault.renameCode) {
        throw Object.assign(new Error('companion rename failed'), { code: guardFault.renameCode })
      }
      await filesystem.rename(...args)
      if (movingCompanion && guardFault.afterMove) {
        await filesystem.unlink(guardFault.path)
        if (guardFault.afterMove === 'replace') {
          await filesystem.symlink(guardFault.replacementTarget, guardFault.path)
        }
      }
    }
  }
})

class ServeChild extends EventEmitter {
  pid = 4101
  kill = vi.fn()
}

describe.skipIf(process.platform === 'win32')('serve singleton guard release', () => {
  const roots: string[] = []

  afterEach(async () => {
    Object.assign(guardFault, {
      path: '',
      companionPath: '',
      armed: false,
      unlinkCode: null,
      unlinkFailuresRemaining: null,
      readlinkCode: null,
      renameCode: null,
      afterMove: null,
      replacementTarget: '',
      backupPath: '',
      backupUnlinkFailures: 0,
      markerPath: '',
      markerCode: null,
      markerCreatedBeforeFailure: false,
      statPath: '',
      statCode: null
    })
    vi.restoreAllMocks()
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
  })

  async function createProfile(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'orca-singleton-guard-'))
    roots.push(root)
    guardFault.path = join(root, 'SingletonLock')
    guardFault.companionPath = join(root, 'SingletonCookie')
    await symlink(`${hostname()}-987654`, guardFault.path)
    await symlink('stale-cookie', join(root, 'SingletonCookie'))
    return root
  }

  function recoverProfile(
    root: string,
    suffix = 'guard-test'
  ): Promise<ServeSingletonRecoveryResult> {
    return recoverStaleServeSingleton(root, {
      platform: 'linux',
      probeHealth: async () => ({ healthy: false, reason: 'metadata_missing' }),
      isProcessAlive: () => false,
      wait: async () => undefined,
      quarantineSuffix: suffix,
      createRecoveryGuardLink: async (target, path) => {
        await symlink(target, path)
        guardFault.armed = true
      }
    })
  }

  it('retains the original lock when rollback cannot unlink its own guard once', async () => {
    const root = await createProfile()
    guardFault.renameCode = 'EIO'
    guardFault.unlinkCode = 'EPERM'
    guardFault.unlinkFailuresRemaining = 1

    await expect(recoverProfile(root)).resolves.toMatchObject({
      state: 'not-recoverable',
      reason: 'quarantine_failed',
      errorCode: 'EIO'
    })
    const targets = (await readdir(root))
      .filter((name) => name.startsWith('SingletonLock'))
      .map((name) => {
        try {
          return readlinkSync(join(root, name))
        } catch {
          return null
        }
      })
    expect(targets).toContain(`${hostname()}-987654`)
  })

  it('preserves unconfirmed rollback evidence across scanning and the next startup', async () => {
    const root = await createProfile()
    const suffix = 'stale-1000-2147483647'
    guardFault.renameCode = 'EIO'
    guardFault.unlinkCode = 'EPERM'
    guardFault.unlinkFailuresRemaining = 1
    const recovery = await recoverProfile(root, suffix)

    expect(recovery).toEqual({
      state: 'not-recoverable',
      reason: 'quarantine_failed',
      errorCode: 'EIO'
    })
    const backup = join(root, `SingletonLock.${suffix}`)
    expect(readlinkSync(backup)).toBe(`${hostname()}-987654`)
    await expect(removeAbandonedServeSingletonQuarantines(root, root, () => false)).rejects.toThrow(
      'Unconfirmed singleton backup'
    )
    const childEnv: NodeJS.ProcessEnv = {}
    await expect(prepareLinuxServeSupervision(root, root, childEnv)).rejects.toThrow(
      'Unconfirmed singleton backup'
    )
    expect(childEnv.ORCA_SERVE_SUPERVISED).toBeUndefined()
    expect(readlinkSync(backup)).toBe(`${hostname()}-987654`)
    expect(readlinkSync(guardFault.path)).toBe(`${hostname()}-${process.pid}`)
    expect(await readdir(root)).not.toContain(`SingletonRecoveryCommit.${suffix}`)
  })

  it('cleans only completed quarantine paths when guard release prevents recovery', async () => {
    const root = await createProfile()
    guardFault.unlinkCode = 'EPERM'
    const child = new ServeChild()
    const spawnChild = vi.fn()
    const sleep = vi.fn(async () => undefined)
    const result = superviseForegroundServe({
      executable: '/opt/orca/orca',
      childArgs: ['--serve'],
      spawnOptions: {},
      spawnChild,
      handoffPath: null,
      child: child as never,
      expectedHandoff: null,
      recoverSingleton: () => recoverProfile(root),
      cleanupSingletonQuarantine: (paths) => removeServeSingletonQuarantine(root, paths),
      sleep
    })
    child.emit('exit', SERVE_ALREADY_RUNNING_EXIT_CODE, null)

    await expect(result).resolves.toBe(SERVE_ALREADY_RUNNING_EXIT_CODE)
    expect(readlinkSync(guardFault.path)).toBe(`${hostname()}-${process.pid}`)
    expect(await readdir(root)).toEqual(['SingletonLock'])
    expect(spawnChild).not.toHaveBeenCalled()
    expect(sleep).not.toHaveBeenCalled()
  })

  it.each([
    { guardState: 'released', unlinkCode: null },
    { guardState: 'retained', unlinkCode: 'EPERM' }
  ])(
    'keeps uncommitted backups after marker creation fails with guard $guardState',
    async ({ unlinkCode }) => {
      const root = await createProfile()
      const suffix = 'stale-1000-2147483647'
      guardFault.markerPath = join(root, `SingletonRecoveryCommit.${suffix}`)
      guardFault.markerCode = 'ENOSPC'
      guardFault.unlinkCode = unlinkCode
      const recoveries: ServeSingletonRecoveryResult[] = []
      const child = new ServeChild()
      const spawnChild = vi.fn()
      const sleep = vi.fn(async () => undefined)
      const cleanupSingletonQuarantine = vi.fn((paths: readonly string[]) =>
        removeServeSingletonQuarantine(root, paths)
      )
      const result = superviseForegroundServe({
        executable: '/opt/orca/orca',
        childArgs: ['--serve'],
        spawnOptions: {},
        spawnChild,
        handoffPath: null,
        child: child as never,
        expectedHandoff: null,
        recoverSingleton: async () => {
          const recovery = await recoverProfile(root, suffix)
          recoveries.push(recovery)
          return recovery
        },
        cleanupSingletonQuarantine,
        sleep
      })
      child.emit('exit', SERVE_ALREADY_RUNNING_EXIT_CODE, null)

      await expect(result).resolves.toBe(SERVE_ALREADY_RUNNING_EXIT_CODE)
      expect(readlinkSync(join(root, `SingletonLock.${suffix}`))).toBe(`${hostname()}-987654`)
      expect(readlinkSync(join(root, `SingletonCookie.${suffix}`))).toBe('stale-cookie')
      expect(recoveries).toEqual([
        { state: 'not-recoverable', reason: 'quarantine_failed', errorCode: 'ENOSPC' }
      ])
      expect(cleanupSingletonQuarantine).not.toHaveBeenCalled()
      expect(spawnChild).not.toHaveBeenCalled()
      expect(sleep).not.toHaveBeenCalled()
      const retainedEntries = (await readdir(root)).sort()
      if (unlinkCode) {
        expect(readlinkSync(guardFault.path)).toBe(`${hostname()}-${process.pid}`)
      } else {
        expect(retainedEntries).not.toContain('SingletonLock')
      }
      const scan = await removeAbandonedServeSingletonQuarantines(root, root, () => false).then(
        () => null,
        (error: unknown) => error
      )
      const childEnv: NodeJS.ProcessEnv = {}
      const startup = await prepareLinuxServeSupervision(root, root, childEnv).then(
        () => null,
        (error: unknown) => error
      )
      expect(readlinkSync(join(root, `SingletonLock.${suffix}`))).toBe(`${hostname()}-987654`)
      expect(scan).toMatchObject({
        message: expect.stringContaining('refusing to discard ownership evidence')
      })
      expect(startup).toMatchObject({
        message: expect.stringContaining('refusing to discard ownership evidence')
      })
      expect(retainedEntries).not.toContain(`SingletonRecoveryCommit.${suffix}`)
      expect(childEnv.ORCA_SERVE_SUPERVISED).toBeUndefined()
      expect((await readdir(root)).sort()).toEqual(retainedEntries)
    }
  )

  it('retries removal of a duplicate backup after the original lock was restored', async () => {
    const root = await createProfile()
    const suffix = 'stale-1000-2147483647'
    const backup = join(root, `SingletonLock.${suffix}`)
    guardFault.renameCode = 'EIO'
    guardFault.backupPath = backup
    guardFault.backupUnlinkFailures = 1
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    await expect(recoverProfile(root, suffix)).resolves.toEqual({
      state: 'not-recoverable',
      reason: 'quarantine_failed',
      errorCode: 'EIO'
    })
    expect(readlinkSync(guardFault.path)).toBe(`${hostname()}-987654`)
    expect(readlinkSync(backup)).toBe(`${hostname()}-987654`)
    const childEnv: NodeJS.ProcessEnv = {}
    await expect(prepareLinuxServeSupervision(root, root, childEnv)).resolves.toBeUndefined()
    expect(childEnv.ORCA_SERVE_SUPERVISED).toBe('1')
    expect(await readdir(root)).not.toContain(`SingletonLock.${suffix}`)
    expect(readlinkSync(guardFault.path)).toBe(`${hostname()}-987654`)
  })

  it('reconciles an atomic marker left by an uncertain EIO after the recoverer exits', async () => {
    const root = await createProfile()
    const suffix = 'stale-1000-2147483647'
    const marker = join(root, `SingletonRecoveryCommit.${suffix}`)
    guardFault.markerPath = marker
    guardFault.markerCode = 'EIO'
    guardFault.markerCreatedBeforeFailure = true
    const recoveries: ServeSingletonRecoveryResult[] = []
    const child = new ServeChild()
    const spawnChild = vi.fn()
    const sleep = vi.fn(async () => undefined)
    const cleanupSingletonQuarantine = vi.fn((paths: readonly string[]) =>
      removeServeSingletonQuarantine(root, paths)
    )
    const result = superviseForegroundServe({
      executable: '/opt/orca/orca',
      childArgs: ['--serve'],
      spawnOptions: {},
      spawnChild,
      handoffPath: null,
      child: child as never,
      expectedHandoff: null,
      recoverSingleton: async () => {
        const recovery = await recoverProfile(root, suffix)
        recoveries.push(recovery)
        return recovery
      },
      cleanupSingletonQuarantine,
      sleep
    })
    child.emit('exit', SERVE_ALREADY_RUNNING_EXIT_CODE, null)

    await expect(result).resolves.toBe(SERVE_ALREADY_RUNNING_EXIT_CODE)
    expect(recoveries).toEqual([
      { state: 'not-recoverable', reason: 'quarantine_failed', errorCode: 'EIO' }
    ])
    expect(cleanupSingletonQuarantine).not.toHaveBeenCalled()
    expect(spawnChild).not.toHaveBeenCalled()
    expect(sleep).not.toHaveBeenCalled()
    expect(readlinkSync(marker)).toBe('orca-singleton-recovery-commit-v1')
    expect(readlinkSync(join(root, `SingletonLock.${suffix}`))).toBe(`${hostname()}-987654`)
    expect(readlinkSync(join(root, `SingletonCookie.${suffix}`))).toBe('stale-cookie')
    const committedEntries = (await readdir(root)).sort()
    await removeAbandonedServeSingletonQuarantines(root, root, () => true)
    expect((await readdir(root)).sort()).toEqual(committedEntries)
    await removeAbandonedServeSingletonQuarantines(root, root, () => false)
    expect(await readdir(root)).toEqual([])
    const childEnv: NodeJS.ProcessEnv = {}
    await expect(prepareLinuxServeSupervision(root, root, childEnv)).resolves.toBeUndefined()
    expect(childEnv.ORCA_SERVE_SUPERVISED).toBe('1')
  })

  it.each(['SingletonRecoveryCommit', 'SingletonLock'])(
    'refuses an occupied recovery suffix without changing its existing %s',
    async (name) => {
      const root = await createProfile()
      const suffix = 'stale-1000-2147483647'
      const existing = join(root, `${name}.${suffix}`)
      const target =
        name === 'SingletonRecoveryCommit'
          ? 'orca-singleton-recovery-commit-v1'
          : 'earlier-backup-owner'
      await symlink(target, existing)

      const result = await recoverProfile(root, suffix)

      expect(readlinkSync(existing)).toBe(target)
      expect(readlinkSync(guardFault.path)).toBe(`${hostname()}-987654`)
      expect(readlinkSync(guardFault.companionPath)).toBe('stale-cookie')
      expect(result).toEqual({
        state: 'not-recoverable',
        reason: 'quarantine_failed',
        errorCode: 'EEXIST'
      })
      expect((await readdir(root)).sort()).toEqual(
        ['SingletonCookie', 'SingletonLock', `${name}.${suffix}`].sort()
      )
    }
  )

  it('refuses recovery before moving artifacts when a suffix cannot be inspected', async () => {
    const root = await createProfile()
    const suffix = 'stale-1000-2147483647'
    guardFault.statPath = join(root, `SingletonLock.${suffix}`)
    guardFault.statCode = 'EACCES'

    await expect(recoverProfile(root, suffix)).resolves.toEqual({
      state: 'not-recoverable',
      reason: 'quarantine_failed',
      errorCode: 'EACCES'
    })
    expect(readlinkSync(guardFault.path)).toBe(`${hostname()}-987654`)
    expect(readlinkSync(guardFault.companionPath)).toBe('stale-cookie')
    expect((await readdir(root)).sort()).toEqual(['SingletonCookie', 'SingletonLock'])
  })

  it('refuses replacement when its live recovery guard cannot be removed', async () => {
    const root = await createProfile()
    guardFault.unlinkCode = 'EPERM'
    const recoveries: ServeSingletonRecoveryResult[] = []
    const recoverSingleton = async (): Promise<ServeSingletonRecoveryResult> => {
      const recovery = await recoverProfile(root)
      recoveries.push(recovery)
      return recovery
    }
    const child = new ServeChild()
    const spawnChild = vi.fn(() => {
      const replacement = new ServeChild()
      setTimeout(() => replacement.emit('exit', SERVE_SUPERVISOR_STOP_EXIT_CODE, null), 0)
      return replacement as never
    })
    const sleep = vi.fn(async () => undefined)
    const result = superviseForegroundServe({
      executable: '/opt/orca/orca',
      childArgs: ['--serve'],
      spawnOptions: {},
      spawnChild,
      handoffPath: null,
      child: child as never,
      expectedHandoff: null,
      recoverSingleton,
      sleep
    })
    child.emit('exit', SERVE_ALREADY_RUNNING_EXIT_CODE, null)
    const code = await result

    expect(readlinkSync(guardFault.path)).toBe(`${hostname()}-${process.pid}`)
    expect(readlinkSync(join(root, 'SingletonRecoveryCommit.guard-test'))).toBe(
      'orca-singleton-recovery-commit-v1'
    )
    expect(recoveries).toEqual([
      {
        state: 'not-recoverable',
        reason: 'quarantine_failed',
        errorCode: 'EPERM',
        cleanupPaths: [
          'SingletonCookie.guard-test',
          'SingletonLock.guard-test',
          'SingletonRecoveryCommit.guard-test'
        ]
      }
    ])
    expect(code).toBe(SERVE_ALREADY_RUNNING_EXIT_CODE)
    expect(spawnChild).not.toHaveBeenCalled()
    expect(sleep).not.toHaveBeenCalled()
  })

  it('refuses recovery when it cannot verify that its guard was released', async () => {
    const root = await createProfile()
    guardFault.readlinkCode = 'EACCES'

    await expect(recoverProfile(root)).resolves.toEqual({
      state: 'not-recoverable',
      reason: 'quarantine_failed',
      errorCode: 'EACCES'
    })
    expect(readlinkSync(guardFault.path)).toBe(`${hostname()}-${process.pid}`)
  })

  it('preserves a foreign owner that replaces its recovery guard', async () => {
    const root = await createProfile()
    guardFault.afterMove = 'replace'
    guardFault.replacementTarget = `${hostname()}-123456`

    await expect(recoverProfile(root)).resolves.toEqual({
      state: 'not-recoverable',
      reason: 'owner_changed'
    })
    expect(readlinkSync(guardFault.path)).toBe(guardFault.replacementTarget)
  })

  it('accepts a guard that disappeared before its release check', async () => {
    const root = await createProfile()
    guardFault.afterMove = 'remove'

    await expect(recoverProfile(root)).resolves.toMatchObject({ state: 'recovered' })
    expect(() => readlinkSync(guardFault.path)).toThrow(expect.objectContaining({ code: 'ENOENT' }))
  })

  it('accepts a guard that disappeared during unlink', async () => {
    const root = await createProfile()
    guardFault.unlinkCode = 'ENOENT'

    await expect(recoverProfile(root)).resolves.toMatchObject({ state: 'recovered' })
    expect(() => readlinkSync(guardFault.path)).toThrow(expect.objectContaining({ code: 'ENOENT' }))
  })

  it('keeps the original move error when releasing the guard also fails', async () => {
    const root = await createProfile()
    guardFault.renameCode = 'EIO'
    guardFault.unlinkCode = 'EPERM'
    const diagnostic = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    await expect(recoverProfile(root)).resolves.toEqual({
      state: 'not-recoverable',
      reason: 'quarantine_failed',
      errorCode: 'EIO'
    })
    expect(readlinkSync(guardFault.path)).toBe(`${hostname()}-${process.pid}`)
    expect(diagnostic).toHaveBeenCalledWith(
      '[serve] Could not remove guard for singleton rollback:',
      expect.objectContaining({ code: 'EPERM' })
    )
    expect(readlinkSync(join(root, 'SingletonLock.guard-test'))).toBe(`${hostname()}-987654`)
  })
})
