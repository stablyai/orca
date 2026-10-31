import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { acquireSkillInstallLock, skillInstallLockPath } from './skill-install-lock'

const hooks: {
  afterOpen: ((path: string) => Promise<void>) | null
  afterRead: ((path: string) => Promise<void>) | null
  afterReaddir: ((path: string) => Promise<void>) | null
  openedPaths: string[]
} = { afterOpen: null, afterRead: null, afterReaddir: null, openedPaths: [] }

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  const actualOpen = actual.open as (
    path: string,
    flags?: string,
    mode?: number
  ) => Promise<unknown>
  const actualReadFile = actual.readFile as (path: string, options?: unknown) => Promise<unknown>
  const actualReaddir = actual.readdir as (path: string, options?: unknown) => Promise<unknown>
  const patched = {
    ...actual,
    open: async (path: string, flags?: string, mode?: number) => {
      const handle = await actualOpen(path, flags, mode)
      hooks.openedPaths.push(String(path))
      await hooks.afterOpen?.(String(path))
      return handle
    },
    readFile: async (path: string, options?: unknown) => {
      const contents = await actualReadFile(path, options)
      await hooks.afterRead?.(String(path))
      return contents
    },
    readdir: async (path: string, options?: unknown) => {
      const entries = await actualReaddir(path, options)
      await hooks.afterReaddir?.(String(path))
      return entries
    }
  }
  return { ...patched, default: patched }
})

const roots: string[] = []

afterEach(async () => {
  hooks.afterOpen = null
  hooks.afterRead = null
  hooks.afterReaddir = null
  hooks.openedPaths = []
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function makeLockPath(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'orca-skill-lock-ownership-test-'))
  roots.push(root)
  return skillInstallLockPath(join(root, 'state'), join(root, 'skills', 'alpha'))
}

async function ownerNames(path: string): Promise<string[]> {
  return (await readdir(path)).filter((name) => name.endsWith('.owner'))
}

describe('skill install lock release ownership', () => {
  it('leaves the contender that reclaimed the lock holding its own directory', async () => {
    const lockPath = await makeLockPath()
    const release = await acquireSkillInstallLock({ path: lockPath, timeoutMs: 10_000 })
    const contender = acquireSkillInstallLock({ path: lockPath, timeoutMs: 10_000 })
    // Any reclaim signal published inside the live directory lets the contender take the lock
    // before the release that published it has taken that directory away.
    hooks.afterOpen = async (path) => {
      if (dirname(path) !== lockPath || !path.endsWith('.released')) {
        return
      }
      hooks.afterOpen = null
      await contender
    }

    await release()
    const releaseContender = await contender

    await expect(ownerNames(lockPath)).resolves.toHaveLength(1)
    await releaseContender()
    await expect(readdir(lockPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('never publishes a reclaim marker inside the live lock directory', async () => {
    const lockPath = await makeLockPath()

    const release = await acquireSkillInstallLock({ path: lockPath, timeoutMs: 10_000 })
    await release()

    expect(
      hooks.openedPaths.filter((path) => dirname(path) === lockPath && path.endsWith('.released'))
    ).toEqual([])
  })

  it('leaves a republished directory alone when ownership changes after the release check', async () => {
    const lockPath = await makeLockPath()
    const release = await acquireSkillInstallLock({ path: lockPath, timeoutMs: 10_000 })
    const foreignToken = '99999999-9999-4999-8999-999999999999'
    const foreignOwner = JSON.stringify({
      token: foreignToken,
      pid: 2_147_483_647,
      createdAt: Date.now()
    })
    // Reclaim and republish in the window between the release's ownership check and its take-away.
    hooks.afterRead = async (path) => {
      if (dirname(path) !== lockPath || !path.endsWith('.owner')) {
        return
      }
      hooks.afterRead = null
      await rm(lockPath, { recursive: true })
      await mkdir(lockPath, { mode: 0o700 })
      await writeFile(join(lockPath, `${foreignToken}.owner`), foreignOwner, { mode: 0o600 })
    }

    await release()

    await expect(readdir(lockPath)).resolves.toEqual([`${foreignToken}.owner`])
    await expect(readFile(join(lockPath, `${foreignToken}.owner`), 'utf8')).resolves.toBe(
      foreignOwner
    )
  })

  it('leaves a republished working directory alone when ownership changes after the check', async () => {
    const lockPath = await makeLockPath()
    const release = await acquireSkillInstallLock({ path: lockPath, timeoutMs: 10_000 })
    const foreignToken = '88888888-8888-4888-8888-888888888888'
    // Why: a new owner that already started work leaves entries beyond its owner record, which is
    // exactly the shape the polluted-directory park path acts on.
    hooks.afterRead = async (path) => {
      if (dirname(path) !== lockPath || !path.endsWith('.owner')) {
        return
      }
      hooks.afterRead = null
      await rm(lockPath, { recursive: true })
      await mkdir(lockPath, { mode: 0o700 })
      await writeFile(
        join(lockPath, `${foreignToken}.owner`),
        JSON.stringify({ token: foreignToken, pid: 2_147_483_647, createdAt: Date.now() })
      )
      await writeFile(join(lockPath, 'in-progress-work'), 'preserve')
    }

    await release()

    await expect(readdir(lockPath)).resolves.toEqual(
      expect.arrayContaining([`${foreignToken}.owner`, 'in-progress-work'])
    )
  })

  it('leaves a republished directory alone when ownership changes after every check', async () => {
    const lockPath = await makeLockPath()
    const release = await acquireSkillInstallLock({ path: lockPath, timeoutMs: 10_000 })
    const foreignToken = '77777777-7777-4777-8777-777777777777'
    // Why: the take-away must carry its own ownership proof, so it has to survive a reclaim that
    // lands after the release has finished looking at the directory.
    hooks.afterReaddir = async (path) => {
      if (path !== lockPath) {
        return
      }
      hooks.afterReaddir = null
      await rm(lockPath, { recursive: true })
      await mkdir(lockPath, { mode: 0o700 })
      await writeFile(
        join(lockPath, `${foreignToken}.owner`),
        JSON.stringify({ token: foreignToken, pid: 2_147_483_647, createdAt: Date.now() })
      )
    }

    await release()

    await expect(readdir(lockPath)).resolves.toEqual([`${foreignToken}.owner`])
  })

  it('parks a polluted lock directory aside so the canonical path stays usable', async () => {
    const lockPath = await makeLockPath()
    const release = await acquireSkillInstallLock({ path: lockPath, timeoutMs: 10_000 })
    await writeFile(join(lockPath, 'unexpected-entry'), 'preserve')

    await release()

    await expect(readdir(lockPath)).rejects.toMatchObject({ code: 'ENOENT' })
    const parked = (await readdir(dirname(lockPath))).find((name) =>
      name.startsWith(`${basename(lockPath)}.`)
    )
    expect(parked).toMatch(/\.released$/)
    await expect(readdir(join(dirname(lockPath), parked ?? ''))).resolves.toEqual([
      'unexpected-entry'
    ])
    const secondRelease = await acquireSkillInstallLock({ path: lockPath, timeoutMs: 10_000 })
    await secondRelease()
  })

  it('keeps contended acquisitions mutually exclusive', async () => {
    const lockPath = await makeLockPath()
    let held = 0
    let overlaps = 0
    let completed = 0

    await Promise.all(
      Array.from({ length: 8 }, async () => {
        const release = await acquireSkillInstallLock({ path: lockPath, timeoutMs: 30_000 })
        held += 1
        overlaps += held > 1 ? 1 : 0
        await new Promise((resolve) => setTimeout(resolve, 1))
        overlaps += held > 1 ? 1 : 0
        held -= 1
        completed += 1
        await release()
      })
    )

    expect(overlaps).toBe(0)
    expect(completed).toBe(8)
    await expect(readdir(lockPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('reclaims a directory lock whose owning process is gone', async () => {
    const lockPath = await makeLockPath()
    const deadToken = '11111111-1111-4111-8111-111111111111'
    await mkdir(lockPath, { recursive: true, mode: 0o700 })
    await writeFile(
      join(lockPath, `${deadToken}.owner`),
      JSON.stringify({ token: deadToken, pid: 2_147_483_647, createdAt: Date.now() })
    )

    const release = await acquireSkillInstallLock({ path: lockPath, timeoutMs: 10_000 })

    await expect(ownerNames(lockPath)).resolves.toEqual([expect.not.stringContaining(deadToken)])
    await release()
    await expect(readdir(lockPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
