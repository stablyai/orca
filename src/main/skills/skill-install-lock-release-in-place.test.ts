import { mkdtemp, readdir, rm } from 'node:fs/promises'
import type * as NodeFsPromises from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SKILL_INSTALL_BUSY_FAILURE } from '../../shared/skill-install-failure'
import { acquireSkillInstallLock, skillInstallLockPath } from './skill-install-lock'

type FsHooks = { ownerUnlinkFailures: number; afterMarkerClosed: (() => Promise<void>) | null }

const fsHooks = vi.hoisted((): FsHooks => ({ ownerUnlinkFailures: 0, afterMarkerClosed: null }))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFsPromises>()
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args)
      const afterClose = fsHooks.afterMarkerClosed
      if (afterClose && String(args[0]).endsWith('.released')) {
        fsHooks.afterMarkerClosed = null
        const close = handle.close.bind(handle)
        handle.close = async () => {
          await close()
          await afterClose()
        }
      }
      return handle
    },
    unlink: async (...[path]: Parameters<typeof actual.unlink>) => {
      if (fsHooks.ownerUnlinkFailures > 0 && String(path).endsWith('.owner')) {
        fsHooks.ownerUnlinkFailures -= 1
        // Windows refuses to delete a file another process holds open without delete sharing.
        throw Object.assign(new Error(`EPERM: operation not permitted, unlink '${String(path)}'`), {
          code: 'EPERM'
        })
      }
      await actual.unlink(path)
    }
  }
})

const roots: string[] = []

afterEach(async () => {
  fsHooks.ownerUnlinkFailures = 0
  fsHooks.afterMarkerClosed = null
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function createLockPath(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'orca-skill-lock-release-in-place-'))
  roots.push(root)
  return skillInstallLockPath(join(root, 'state'), join(root, 'skills', 'alpha'))
}

describe('skill install lock release in place', () => {
  it('reports the release when tidying the lock folder fails, and the next acquirer reclaims it', async () => {
    const lockPath = await createLockPath()
    const release = await acquireSkillInstallLock({ path: lockPath })
    fsHooks.ownerUnlinkFailures = 1

    await expect(release()).resolves.toBeUndefined()
    const leftovers = await readdir(lockPath)
    expect(leftovers).toHaveLength(2)
    expect(leftovers.some((name) => name.endsWith('.released'))).toBe(true)

    const next = await acquireSkillInstallLock({ path: lockPath, timeoutMs: 1_000 })
    await next()
    await expect(readdir(dirname(lockPath))).resolves.toEqual([])
  })

  it('leaves a newer holder in place when it reclaims the lock before release tidies up', async () => {
    const lockPath = await createLockPath()
    const releaseFirst = await acquireSkillInstallLock({ path: lockPath })
    let markerIsDurable!: () => void
    const markerWritten = new Promise<void>((resolve) => {
      markerIsDurable = resolve
    })
    let resumeRelease!: () => void
    const mayResumeRelease = new Promise<void>((resolve) => {
      resumeRelease = resolve
    })
    fsHooks.afterMarkerClosed = async () => {
      markerIsDurable()
      await mayResumeRelease
    }

    const releasingFirst = releaseFirst()
    await markerWritten
    const releaseSecond = await acquireSkillInstallLock({ path: lockPath, timeoutMs: 1_000 })
    const secondEntries = await readdir(lockPath)
    expect(secondEntries).toEqual([expect.stringMatching(/\.owner$/)])
    resumeRelease()
    await expect(releasingFirst).resolves.toBeUndefined()

    await expect(readdir(lockPath)).resolves.toEqual(secondEntries)
    await expect(acquireSkillInstallLock({ path: lockPath, timeoutMs: 150 })).rejects.toMatchObject(
      { data: SKILL_INSTALL_BUSY_FAILURE }
    )
    await releaseSecond()
    await expect(readdir(dirname(lockPath))).resolves.toEqual([])
  })
})
