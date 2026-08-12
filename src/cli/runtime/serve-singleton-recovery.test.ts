import { readFileSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { lstat, mkdir, mkdtemp, readlink, rm, symlink } from 'node:fs/promises'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { recoverStaleServeSingleton, SINGLETON_ARTIFACT_NAMES } from './serve-singleton-recovery'

async function pathExists(path: string): Promise<boolean> {
  return lstat(path).then(
    () => true,
    () => false
  )
}

describe.skipIf(process.platform === 'win32')('serve singleton recovery', () => {
  const roots: string[] = []

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
  })

  async function createProfileWithLockTarget(lockTarget: string): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'orca-singleton-recovery-'))
    roots.push(root)
    await symlink(lockTarget, join(root, 'SingletonLock'))
    await symlink('/tmp/orca-stale/SingletonSocket', join(root, 'SingletonSocket'))
    await symlink('synthetic-cookie', join(root, 'SingletonCookie'))
    return root
  }

  async function createProfile(ownerPid: number): Promise<string> {
    return createProfileWithLockTarget(`${hostname()}-${ownerPid}`)
  }

  it('quarantines a confirmed stale local owner', async () => {
    const root = await createProfile(987_654)
    const probeHealth = vi.fn(async () => ({
      healthy: false as const,
      reason: 'metadata_missing' as const
    }))

    const result = await recoverStaleServeSingleton(root, {
      platform: 'linux',
      probeHealth,
      isProcessAlive: () => false,
      wait: async () => undefined,
      quarantineSuffix: 'test-stale'
    })

    expect(result).toMatchObject({ state: 'recovered', ownerPid: 987_654 })
    expect(probeHealth).toHaveBeenCalledTimes(2)
    for (const name of SINGLETON_ARTIFACT_NAMES) {
      expect(await pathExists(join(root, name))).toBe(false)
      expect(await pathExists(join(root, `${name}.test-stale`))).toBe(true)
    }
  })

  it('does not touch an active runtime owner', async () => {
    const root = await createProfile(4101)

    const result = await recoverStaleServeSingleton(root, {
      platform: 'linux',
      probeHealth: async () => ({ healthy: true, runtimeId: 'runtime-live' }),
      isProcessAlive: () => true,
      wait: async () => undefined,
      quarantineSuffix: 'must-not-exist'
    })

    expect(result).toEqual({ state: 'active-owner', runtimeId: 'runtime-live' })
    expect(await readlink(join(root, 'SingletonLock'))).toBe(`${hostname()}-4101`)
    expect(await pathExists(join(root, 'SingletonLock.must-not-exist'))).toBe(false)
  })

  it('does not touch a live or ambiguous lock owner when runtime health is unavailable', async () => {
    const root = await createProfile(4101)

    const result = await recoverStaleServeSingleton(root, {
      platform: 'linux',
      probeHealth: async () => ({ healthy: false, reason: 'graph_not_ready' }),
      isProcessAlive: () => true,
      wait: async () => undefined,
      quarantineSuffix: 'must-not-exist'
    })

    expect(result).toMatchObject({ state: 'not-recoverable', reason: 'owner_process_alive' })
    expect(await readlink(join(root, 'SingletonLock'))).toBe(`${hostname()}-4101`)
  })

  it('preserves a replacement owner that appears after confirmation', async () => {
    const root = await createProfile(987_654)
    const lockPath = join(root, 'SingletonLock')
    const replacementTarget = `${hostname()}-123456`
    let livenessChecks = 0

    const result = await recoverStaleServeSingleton(root, {
      platform: 'linux',
      probeHealth: async () => ({ healthy: false, reason: 'metadata_missing' }),
      isProcessAlive: () => {
        livenessChecks += 1
        if (livenessChecks === 2) {
          unlinkSync(lockPath)
          symlinkSync(replacementTarget, lockPath)
        }
        return false
      },
      wait: async () => undefined,
      quarantineSuffix: 'must-not-exist'
    })

    expect(result).toEqual({ state: 'not-recoverable', reason: 'owner_changed' })
    expect(await readlink(lockPath)).toBe(replacementTarget)
    expect(await pathExists(join(root, 'SingletonSocket'))).toBe(true)
    expect(await pathExists(join(root, 'SingletonCookie'))).toBe(true)
  })

  it('restores a moved replacement lock when its target cannot be read', async () => {
    const root = await createProfile(987_654)
    const lockPath = join(root, 'SingletonLock')
    let livenessChecks = 0

    const result = await recoverStaleServeSingleton(root, {
      platform: 'linux',
      probeHealth: async () => ({ healthy: false, reason: 'metadata_missing' }),
      isProcessAlive: () => {
        livenessChecks += 1
        if (livenessChecks === 2) {
          unlinkSync(lockPath)
          writeFileSync(lockPath, 'replacement-owner')
        }
        return false
      },
      wait: async () => undefined,
      quarantineSuffix: 'must-not-exist'
    })

    expect(result).toEqual({ state: 'not-recoverable', reason: 'owner_changed' })
    expect(readFileSync(lockPath, 'utf8')).toBe('replacement-owner')
    expect(await pathExists(join(root, 'SingletonLock.must-not-exist'))).toBe(false)
    expect(await pathExists(join(root, 'SingletonSocket'))).toBe(true)
    expect(await pathExists(join(root, 'SingletonCookie'))).toBe(true)
  })

  it('preserves a replacement owner that claims the lock during quarantine', async () => {
    const root = await createProfile(987_654)
    const lockPath = join(root, 'SingletonLock')
    const replacementTarget = `${hostname()}-123456`

    const result = await recoverStaleServeSingleton(root, {
      platform: 'linux',
      probeHealth: async () => ({ healthy: false, reason: 'metadata_missing' }),
      isProcessAlive: () => false,
      wait: async () => undefined,
      quarantineSuffix: 'must-not-exist',
      createRecoveryGuardLink: async (target, path) => {
        await symlink(replacementTarget, path)
        await symlink(target, path)
      }
    })

    expect(result).toEqual({ state: 'not-recoverable', reason: 'owner_changed' })
    expect(await readlink(lockPath)).toBe(replacementTarget)
    expect(await pathExists(join(root, 'SingletonSocket'))).toBe(true)
    expect(await pathExists(join(root, 'SingletonCookie'))).toBe(true)
    expect(await pathExists(join(root, 'SingletonLock.must-not-exist'))).toBe(false)
  })

  it('restores the stale owner when companion quarantine fails', async () => {
    const root = await createProfile(987_654)
    await mkdir(join(root, 'SingletonSocket.rollback'))

    const result = await recoverStaleServeSingleton(root, {
      platform: 'linux',
      probeHealth: async () => ({ healthy: false, reason: 'metadata_missing' }),
      isProcessAlive: () => false,
      wait: async () => undefined,
      quarantineSuffix: 'rollback'
    })

    expect(result).toEqual({ state: 'not-recoverable', reason: 'quarantine_failed' })
    expect(await readlink(join(root, 'SingletonLock'))).toBe(`${hostname()}-987654`)
    expect(await pathExists(join(root, 'SingletonSocket'))).toBe(true)
    expect(await pathExists(join(root, 'SingletonCookie'))).toBe(true)
    expect(await pathExists(join(root, 'SingletonLock.rollback'))).toBe(false)
    expect(await pathExists(join(root, 'SingletonRecoveryLock'))).toBe(false)
  })

  it.each([
    { lockTarget: 'other-host-4101', reason: 'remote_host_owner' },
    { lockTarget: 'invalid-owner', reason: 'invalid_lock' }
  ])('does not touch a $reason singleton owner', async ({ lockTarget, reason }) => {
    const root = await createProfileWithLockTarget(lockTarget)

    const result = await recoverStaleServeSingleton(root, {
      platform: 'linux',
      probeHealth: async () => ({ healthy: false, reason: 'metadata_missing' }),
      isProcessAlive: () => false,
      wait: async () => undefined,
      quarantineSuffix: 'must-not-exist'
    })

    expect(result).toEqual({ state: 'not-recoverable', reason })
    expect(await readlink(join(root, 'SingletonLock'))).toBe(lockTarget)
    expect(await pathExists(join(root, 'SingletonLock.must-not-exist'))).toBe(false)
  })

  it('uses explicit Linux recovery semantics independently of the test host', async () => {
    const root = await createProfile(987_654)
    const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')!
    Object.defineProperty(process, 'platform', { value: 'darwin' })

    try {
      const result = await recoverStaleServeSingleton(root, {
        platform: 'linux',
        probeHealth: async () => ({ healthy: false, reason: 'metadata_missing' }),
        isProcessAlive: () => false,
        wait: async () => undefined,
        quarantineSuffix: 'test-host-independent'
      })

      expect(result).toMatchObject({ state: 'recovered', ownerPid: 987_654 })
    } finally {
      Object.defineProperty(process, 'platform', platformDescriptor)
    }
  })

  it('fails closed when the initial runtime health probe rejects', async () => {
    const root = await createProfile(987_654)

    await expect(
      recoverStaleServeSingleton(root, {
        platform: 'linux',
        probeHealth: async () => {
          throw new Error('runtime metadata unavailable')
        },
        isProcessAlive: () => false,
        wait: async () => undefined,
        quarantineSuffix: 'must-not-exist'
      })
    ).resolves.toEqual({ state: 'not-recoverable', reason: 'health_probe_failed' })
    expect(await readlink(join(root, 'SingletonLock'))).toBe(`${hostname()}-987654`)
    expect(await pathExists(join(root, 'SingletonLock.must-not-exist'))).toBe(false)
  })

  it('fails closed and releases the mutex when the confirmation health probe rejects', async () => {
    const root = await createProfile(987_654)
    const probeHealth = vi
      .fn()
      .mockResolvedValueOnce({ healthy: false, reason: 'metadata_missing' })
      .mockRejectedValueOnce(new Error('runtime RPC failed'))

    await expect(
      recoverStaleServeSingleton(root, {
        platform: 'linux',
        probeHealth,
        isProcessAlive: () => false,
        wait: async () => undefined,
        quarantineSuffix: 'must-not-exist'
      })
    ).resolves.toEqual({ state: 'not-recoverable', reason: 'health_probe_failed' })
    expect(await pathExists(join(root, 'SingletonRecoveryLock'))).toBe(false)
    expect(await readlink(join(root, 'SingletonLock'))).toBe(`${hostname()}-987654`)
  })

  it('reports a non-EEXIST mutex creation failure', async () => {
    const root = await createProfile(987_654)

    await expect(
      recoverStaleServeSingleton(root, {
        platform: 'linux',
        probeHealth: async () => ({ healthy: false, reason: 'metadata_missing' }),
        isProcessAlive: () => false,
        wait: async () => undefined,
        createMutexLink: async () => {
          throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' })
        }
      })
    ).resolves.toEqual({
      state: 'not-recoverable',
      reason: 'recovery_mutex_failed',
      errorCode: 'ENOSPC'
    })
  })

  it('treats an existing live mutex as recovery in progress', async () => {
    const root = await createProfile(987_654)
    await symlink(String(process.pid), join(root, 'SingletonRecoveryLock'))

    await expect(
      recoverStaleServeSingleton(root, {
        platform: 'linux',
        probeHealth: async () => ({ healthy: false, reason: 'metadata_missing' }),
        isProcessAlive: (pid) => pid === process.pid,
        wait: async () => undefined,
        quarantineSuffix: 'must-not-exist'
      })
    ).resolves.toEqual({ state: 'not-recoverable', reason: 'recovery_in_progress' })
    expect(await readlink(join(root, 'SingletonLock'))).toBe(`${hostname()}-987654`)
    expect(await pathExists(join(root, 'SingletonLock.must-not-exist'))).toBe(false)
  })
})
