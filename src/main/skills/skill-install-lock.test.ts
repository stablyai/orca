import { mkdir, mkdtemp, readdir, readFile, rename, rm, rmdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  acquireSkillInstallLock,
  reclaimDeadSkillInstallLocks,
  skillInstallLockPath
} from './skill-install-lock'
import { readSkillInstallLockOwner } from './skill-install-lock-owner'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function readPublishedOwner(lockPath: string): Promise<Record<string, unknown>> {
  const ownerName = (await readdir(lockPath)).find((name) => name.endsWith('.owner'))
  if (!ownerName) {
    throw new Error('missing-owner')
  }
  return JSON.parse(await readFile(join(lockPath, ownerName), 'utf8')) as Record<string, unknown>
}

describe('skill install lock', () => {
  it.each([0, -1])('rejects a non-positive owner pid (%s)', async (pid) => {
    const root = await mkdtemp(join(tmpdir(), 'orca-skill-lock-test-'))
    roots.push(root)
    const ownerPath = join(root, 'owner.json')
    await writeFile(ownerPath, JSON.stringify({ token: 'invalid-pid', pid, createdAt: Date.now() }))

    await expect(readSkillInstallLockOwner(ownerPath)).resolves.toBeNull()
  })

  it('reclaims a fresh legacy lock whose process was killed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-skill-lock-test-'))
    roots.push(root)
    const lockPath = skillInstallLockPath(join(root, 'state'), join(root, 'skills', 'alpha'))
    await mkdir(dirname(lockPath), { recursive: true })
    await writeFile(
      lockPath,
      JSON.stringify({ token: 'dead-owner', pid: 2_147_483_647, createdAt: Date.now() })
    )

    // Why: reclaiming costs a fsync plus one 50ms retry, so a 100ms budget expires on a
    // loaded CI runner and surfaces the legacy file's rename ENOTDIR instead of reclaiming.
    const release = await acquireSkillInstallLock({ path: lockPath, timeoutMs: 5_000 })
    expect((await readPublishedOwner(lockPath)).token).not.toBe('dead-owner')
    await release()
    await expect(readdir(lockPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('reclaims a lock after its release deletion fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-skill-lock-test-'))
    roots.push(root)
    const lockPath = skillInstallLockPath(join(root, 'state'), join(root, 'skills', 'alpha'))
    const release = await acquireSkillInstallLock({
      path: lockPath,
      timeoutMs: 100,
      removeLock: async () => {
        throw new Error('injected-delete-failure')
      }
    })

    await expect(release()).rejects.toThrow('injected-delete-failure')
    await expect(readdir(lockPath)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readdir(dirname(lockPath))).toEqual(
      expect.arrayContaining([expect.stringMatching(/\.lock\.[a-f0-9-]+\.released$/)])
    )
    const secondRelease = await acquireSkillInstallLock({ path: lockPath, timeoutMs: 100 })
    await secondRelease()
    await expect(readdir(lockPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('publishes a complete candidate atomically when acquisitions overlap', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-skill-lock-test-'))
    roots.push(root)
    const lockPath = skillInstallLockPath(join(root, 'state'), join(root, 'skills', 'alpha'))
    let ownerWritten!: () => void
    const ownerIsVisible = new Promise<void>((resolve) => {
      ownerWritten = resolve
    })
    let finishWrite!: () => void
    const mayFinishWrite = new Promise<void>((resolve) => {
      finishWrite = resolve
    })
    let contentionObserved!: () => void
    const firstContention = new Promise<void>((resolve) => {
      contentionObserved = resolve
    })
    const firstAcquire = acquireSkillInstallLock({
      path: lockPath,
      writeOwner: async (handle, value) => {
        await handle.writeFile(value, 'utf8')
        await handle.sync()
        ownerWritten()
        await mayFinishWrite
      },
      publishLock: async (candidatePath, targetPath) => {
        try {
          await rename(candidatePath, targetPath)
        } catch (error) {
          contentionObserved()
          throw error
        }
      }
    })

    await ownerIsVisible
    await expect(readdir(lockPath)).rejects.toMatchObject({ code: 'ENOENT' })
    const secondRelease = await acquireSkillInstallLock({ path: lockPath, timeoutMs: 100 })
    let firstPublished = false
    const observedFirstAcquire = firstAcquire.then(
      () => {
        firstPublished = true
      },
      () => {
        firstPublished = true
      }
    )
    finishWrite()
    await firstContention
    expect(firstPublished).toBe(false)
    await secondRelease()
    const release = await firstAcquire
    await observedFirstAcquire
    await expect(readPublishedOwner(lockPath)).resolves.toMatchObject({ pid: process.pid })
    await release()
  })

  it('does not publish a lock when writing its owner fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-skill-lock-test-'))
    roots.push(root)
    const lockPath = skillInstallLockPath(join(root, 'state'), join(root, 'skills', 'alpha'))

    await expect(
      acquireSkillInstallLock({
        path: lockPath,
        writeOwner: async () => {
          throw new Error('injected-write-failure')
        }
      })
    ).rejects.toThrow('injected-write-failure')

    await expect(readdir(dirname(lockPath))).resolves.toEqual([])
    const release = await acquireSkillInstallLock({ path: lockPath, timeoutMs: 100 })
    await release()
  })

  it('retries when the current owner releases after a contended rename', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-skill-lock-test-'))
    roots.push(root)
    const lockPath = skillInstallLockPath(join(root, 'state'), join(root, 'skills', 'alpha'))
    const firstRelease = await acquireSkillInstallLock({ path: lockPath })
    let attempts = 0

    const secondRelease = await acquireSkillInstallLock({
      path: lockPath,
      timeoutMs: 500,
      publishLock: async (candidatePath, targetPath) => {
        attempts += 1
        if (attempts === 1) {
          await firstRelease()
          const error = new Error('injected-contention') as NodeJS.ErrnoException
          error.code = 'ENOTEMPTY'
          throw error
        }
        await rename(candidatePath, targetPath)
      }
    })

    expect(attempts).toBe(2)
    await secondRelease()
  })

  it('reclaims abandoned legacy owner files at startup', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-skill-lock-test-'))
    roots.push(root)
    const stateDirectory = join(root, 'state')
    const lockPath = skillInstallLockPath(stateDirectory, join(root, 'skills', 'alpha'))
    const ownerPath = `${lockPath}.11111111-1111-4111-8111-111111111111.owner`
    await mkdir(dirname(ownerPath), { recursive: true })
    await writeFile(
      ownerPath,
      JSON.stringify({ token: 'abandoned-owner', pid: 2_147_483_647, createdAt: Date.now() })
    )

    await expect(reclaimDeadSkillInstallLocks(stateDirectory)).resolves.toMatchObject({
      scanned: 1,
      reclaimed: 1
    })
    await expect(readFile(ownerPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('reclaims dead locks, abandoned candidates, and completed releases at startup', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-skill-lock-test-'))
    roots.push(root)
    const stateDirectory = join(root, 'state')
    const deadPath = skillInstallLockPath(stateDirectory, join(root, 'skills', 'alpha'))
    const releasedLockPath = skillInstallLockPath(stateDirectory, join(root, 'skills', 'beta'))
    const candidateLockPath = skillInstallLockPath(stateDirectory, join(root, 'skills', 'gamma'))
    const deadToken = '11111111-1111-4111-8111-111111111111'
    const releasedToken = '22222222-2222-4222-8222-222222222222'
    const candidateToken = '33333333-3333-4333-8333-333333333333'
    await mkdir(deadPath, { recursive: true })
    const releasedPath = `${releasedLockPath}.${releasedToken}.released`
    const candidatePath = `${candidateLockPath}.${candidateToken}.candidate`
    await mkdir(releasedPath, { recursive: true })
    await mkdir(candidatePath, { recursive: true })
    await writeFile(
      join(deadPath, `${deadToken}.owner`),
      JSON.stringify({ token: deadToken, pid: 2_147_483_647, createdAt: Date.now() })
    )
    await writeFile(
      join(releasedPath, `${releasedToken}.owner`),
      JSON.stringify({ token: releasedToken, pid: process.pid, createdAt: Date.now() })
    )
    await writeFile(
      join(candidatePath, `${candidateToken}.owner`),
      JSON.stringify({ token: candidateToken, pid: 2_147_483_647, createdAt: Date.now() })
    )

    await expect(reclaimDeadSkillInstallLocks(stateDirectory)).resolves.toEqual({
      scanned: 3,
      reclaimed: 3,
      truncated: false
    })
  })

  it('continues startup recovery past a non-empty released lock', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-skill-lock-test-'))
    roots.push(root)
    const stateDirectory = join(root, 'state')
    const lockDirectory = join(stateDirectory, 'locks')
    const releasedToken = '11111111-1111-4111-8111-111111111111'
    const deadToken = '22222222-2222-4222-8222-222222222222'
    const releasedPath = join(lockDirectory, `${'0'.repeat(64)}.lock.${releasedToken}.released`)
    const deadPath = join(lockDirectory, `${'f'.repeat(64)}.lock`)
    await mkdir(releasedPath, { recursive: true })
    await mkdir(deadPath)
    await writeFile(join(releasedPath, 'unexpected-entry'), 'preserve')
    await writeFile(
      join(deadPath, `${deadToken}.owner`),
      JSON.stringify({ token: deadToken, pid: 2_147_483_647, createdAt: Date.now() })
    )

    await expect(reclaimDeadSkillInstallLocks(stateDirectory)).resolves.toEqual({
      scanned: 2,
      reclaimed: 1,
      truncated: false
    })
    await expect(readdir(releasedPath)).resolves.toEqual(['unexpected-entry'])
    await expect(readdir(deadPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('frees the canonical lock before release cleanup finishes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-skill-lock-test-'))
    roots.push(root)
    const stateDirectory = join(root, 'state')
    const lockPath = skillInstallLockPath(stateDirectory, join(root, 'skills', 'alpha'))
    let deletionStarted!: () => void
    const deletionIsPending = new Promise<void>((resolve) => {
      deletionStarted = resolve
    })
    let finishDeletion!: () => void
    const mayFinishDeletion = new Promise<void>((resolve) => {
      finishDeletion = resolve
    })
    const release = await acquireSkillInstallLock({
      path: lockPath,
      removeLock: async (path) => {
        deletionStarted()
        await mayFinishDeletion
        await rmdir(path)
      }
    })
    const releasing = release()
    expect(release()).toBe(releasing)

    await deletionIsPending
    await expect(reclaimDeadSkillInstallLocks(stateDirectory)).resolves.toMatchObject({
      reclaimed: 1
    })
    const secondRelease = await acquireSkillInstallLock({ path: lockPath, timeoutMs: 100 })
    await secondRelease()
    finishDeletion()
    await releasing
  })
})
