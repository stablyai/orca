import { link, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  acquireSkillInstallLock,
  reclaimDeadSkillInstallLocks,
  skillInstallLockPath
} from './skill-install-lock'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('skill install lock', () => {
  it('reclaims a fresh lock whose process was killed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-skill-lock-test-'))
    roots.push(root)
    const lockPath = skillInstallLockPath(join(root, 'state'), join(root, 'skills', 'alpha'))
    await mkdir(dirname(lockPath), { recursive: true })
    await writeFile(
      lockPath,
      JSON.stringify({ token: 'dead-owner', pid: 2_147_483_647, createdAt: Date.now() })
    )

    const release = await acquireSkillInstallLock({ path: lockPath, timeoutMs: 100 })
    expect(JSON.parse(await readFile(lockPath, 'utf8')).token).not.toBe('dead-owner')
    await release()
    await expect(readFile(lockPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('reclaims a same-process lock after its release deletion fails', async () => {
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
    const secondRelease = await acquireSkillInstallLock({ path: lockPath, timeoutMs: 100 })
    await secondRelease()
    await expect(readFile(lockPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('publishes only complete owner records when acquisitions overlap', async () => {
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
    const firstAcquire = acquireSkillInstallLock({
      path: lockPath,
      timeoutMs: 0,
      writeOwner: async (handle, value) => {
        await handle.writeFile(value, 'utf8')
        await handle.sync()
        ownerWritten()
        await mayFinishWrite
      }
    })

    await ownerIsVisible
    const secondRelease = await acquireSkillInstallLock({ path: lockPath, timeoutMs: 100 })
    finishWrite()
    await expect(firstAcquire).rejects.toMatchObject({
      data: { code: 'skill-install-busy' }
    })
    await secondRelease()
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

  it('falls back when the state filesystem does not support hard links', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-skill-lock-test-'))
    roots.push(root)
    const lockPath = skillInstallLockPath(join(root, 'state'), join(root, 'skills', 'alpha'))
    const release = await acquireSkillInstallLock({
      path: lockPath,
      createLink: async () => {
        const error = new Error('hard-links-unsupported') as NodeJS.ErrnoException
        error.code = 'ENOTSUP'
        throw error
      }
    })

    await expect(readFile(lockPath, 'utf8')).resolves.toContain(`"pid":${process.pid}`)
    await release()
    await expect(readFile(lockPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('uses a fresh owner file for each contention retry', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-skill-lock-test-'))
    roots.push(root)
    const lockPath = skillInstallLockPath(join(root, 'state'), join(root, 'skills', 'alpha'))
    const ownerPaths: string[] = []
    const release = await acquireSkillInstallLock({
      path: lockPath,
      timeoutMs: 100,
      createLink: async (ownerPath, targetPath) => {
        ownerPaths.push(ownerPath)
        if (ownerPaths.length === 1) {
          const error = new Error('injected-contention') as NodeJS.ErrnoException
          error.code = 'EEXIST'
          throw error
        }
        await link(ownerPath, targetPath)
      }
    })

    expect(ownerPaths).toHaveLength(2)
    expect(ownerPaths[0]).not.toBe(ownerPaths[1])
    await release()
  })

  it('reclaims abandoned atomic owner files at startup', async () => {
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

  it('keeps ownership active until release deletion finishes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-skill-lock-test-'))
    roots.push(root)
    const lockPath = skillInstallLockPath(join(root, 'state'), join(root, 'skills', 'alpha'))
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
        await rm(path, { force: true })
      }
    })
    const releasing = release()
    expect(release()).toBe(releasing)

    await deletionIsPending
    await expect(acquireSkillInstallLock({ path: lockPath, timeoutMs: 0 })).rejects.toMatchObject({
      data: { code: 'skill-install-busy' }
    })
    finishDeletion()
    await releasing

    const secondRelease = await acquireSkillInstallLock({ path: lockPath, timeoutMs: 100 })
    await secondRelease()
  })
})
