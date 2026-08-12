import { lstat, mkdtemp, readlink, rm, symlink } from 'node:fs/promises'
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

describe('serve singleton recovery', () => {
  const roots: string[] = []

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
  })

  async function createProfile(ownerPid: number): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'orca-singleton-recovery-'))
    roots.push(root)
    await symlink(`${hostname()}-${ownerPid}`, join(root, 'SingletonLock'))
    await symlink('/tmp/orca-stale/SingletonSocket', join(root, 'SingletonSocket'))
    await symlink('synthetic-cookie', join(root, 'SingletonCookie'))
    return root
  }

  it('quarantines a confirmed stale local owner', async () => {
    const root = await createProfile(987_654)
    const probeHealth = vi.fn(async () => ({
      healthy: false as const,
      reason: 'metadata_missing' as const
    }))

    const result = await recoverStaleServeSingleton(root, {
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
      probeHealth: async () => ({ healthy: false, reason: 'graph_not_ready' }),
      isProcessAlive: () => true,
      wait: async () => undefined,
      quarantineSuffix: 'must-not-exist'
    })

    expect(result).toMatchObject({ state: 'not-recoverable', reason: 'owner_process_alive' })
    expect(await readlink(join(root, 'SingletonLock'))).toBe(`${hostname()}-4101`)
  })
})
