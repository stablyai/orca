import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'

const fake = vi.hoisted(() => ({
  files: new Map<string, string>(),
  failures: new Set<string>(),
  names: new Set<string>(),
  readFile: vi.fn<(path: string) => Promise<string>>(),
  readdir: vi.fn<() => Promise<{ name: string; isDirectory: () => boolean }[]>>()
}))
vi.mock('node:fs/promises', () => ({ readFile: fake.readFile, readdir: fake.readdir }))
vi.mock('./worktree-remote', () => ({ notifyWorktreeHeadIdentitiesChanged: vi.fn() }))

import {
  createWorktreeHeadIdentityCache,
  readGitCommonHeadIdentities
} from './worktree-head-identity-reader'
import {
  createWorktreeHeadIdentityRefreshState,
  disposeWorktreeHeadIdentityRefreshState,
  refreshWorktreeHeadIdentities
} from './worktree-head-identity-refresh'
import {
  FULL_HEAD_IDENTITY_SCOPE,
  headIdentityScopeForEntry,
  LISTING_HEAD_IDENTITY_SCOPE,
  PRIMARY_HEAD_IDENTITY_SCOPE
} from './worktree-head-identity-scope'

const COMMON = join('/mock', 'project', '.git')
const OID = 'a'.repeat(40)
const NEW_OID = 'b'.repeat(40)
const entryFile = (name: string, file: string): string => join(COMMON, 'worktrees', name, file)
const worktreePath = (name: string): string => join('/mock', name)

function addEntry(name: string, oid = OID): void {
  fake.names.add(name)
  fake.files.set(entryFile(name, 'gitdir'), join(worktreePath(name), '.git'))
  fake.files.set(entryFile(name, 'HEAD'), oid)
}

function fsError(code: string): Error {
  return Object.assign(new Error(`synthetic ${code}`), { code })
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(1_000_000)
  vi.resetAllMocks()
  fake.files.clear()
  fake.failures.clear()
  fake.names.clear()
  fake.files.set(join(COMMON, 'HEAD'), OID)
  fake.readdir.mockImplementation(async () =>
    [...fake.names].map((name) => ({ name, isDirectory: () => true }))
  )
  fake.readFile.mockImplementation(async (path) => {
    if (fake.failures.has(path)) {
      throw fsError('EIO')
    }
    const value = fake.files.get(path)
    if (value === undefined) {
      throw fsError('ENOENT')
    }
    return value
  })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('head identity failed-entry retirement', () => {
  it.each([true, false])(
    'retires removed failure markers with a prior identity: %s',
    async (seed) => {
      const name = 'wt-e\u0301'
      addEntry(name)
      const cache = createWorktreeHeadIdentityCache()
      if (seed) {
        await readGitCommonHeadIdentities(COMMON, cache)
      }
      fake.failures.add(entryFile(name, 'HEAD'))
      const failed = await readGitCommonHeadIdentities(COMMON, cache)
      expect(failed.complete).toBe(false)
      expect(cache.unverified.has(name)).toBe(true)
      expect(cache.entries.has(name)).toBe(seed)
      fake.names.delete(name)

      const recovered = await readGitCommonHeadIdentities(
        COMMON,
        cache,
        LISTING_HEAD_IDENTITY_SCOPE
      )

      expect(recovered.complete).toBe(true)
      expect(cache.unverified.size).toBe(0)
      expect(cache.entries.size).toBe(0)
      expect(recovered.identities.map((identity) => identity.worktreePath)).toEqual([
        join('/mock', 'project')
      ])
    }
  )

  it.each(['EIO', 'ENOTDIR'])(
    'preserves failure markers when the listing rejects with %s',
    async (code) => {
      addEntry('pending')
      const cache = createWorktreeHeadIdentityCache()
      await readGitCommonHeadIdentities(COMMON, cache)
      fake.failures.add(entryFile('pending', 'HEAD'))
      await readGitCommonHeadIdentities(COMMON, cache)
      fake.names.delete('pending')
      fake.readdir.mockRejectedValue(fsError(code))

      const result = await readGitCommonHeadIdentities(COMMON, cache, LISTING_HEAD_IDENTITY_SCOPE)

      expect(result.complete).toBe(false)
      expect(cache.unverified.has('pending')).toBe(true)
      expect(cache.entries.get('pending')?.head).toBe(OID)
      expect(cache.entryNames).toBeNull()
    }
  )

  it('retires failures when the worktrees directory is confirmed absent', async () => {
    addEntry('removed')
    const cache = createWorktreeHeadIdentityCache()
    fake.failures.add(entryFile('removed', 'HEAD'))
    await readGitCommonHeadIdentities(COMMON, cache)
    fake.readdir.mockRejectedValue(fsError('ENOENT'))

    const result = await readGitCommonHeadIdentities(COMMON, cache, FULL_HEAD_IDENTITY_SCOPE)

    expect(result.complete).toBe(true)
    expect(cache.unverified.size).toBe(0)
    expect(cache.entryNames).toEqual([])
  })

  it('keeps a listed failed entry retryable and preserves its last verified identity', async () => {
    addEntry('pending')
    const cache = createWorktreeHeadIdentityCache()
    await readGitCommonHeadIdentities(COMMON, cache)
    fake.failures.add(entryFile('pending', 'HEAD'))
    await readGitCommonHeadIdentities(COMMON, cache)

    const stillFailed = await readGitCommonHeadIdentities(
      COMMON,
      cache,
      LISTING_HEAD_IDENTITY_SCOPE
    )

    expect(stillFailed.complete).toBe(false)
    expect(cache.unverified.has('pending')).toBe(true)
    expect(cache.entries.get('pending')?.head).toBe(OID)
    fake.failures.clear()
    fake.files.set(entryFile('pending', 'HEAD'), NEW_OID)
    const recovered = await readGitCommonHeadIdentities(COMMON, cache, PRIMARY_HEAD_IDENTITY_SCOPE)
    expect(recovered.complete).toBe(true)
    expect(cache.entries.get('pending')?.head).toBe(NEW_OID)
    expect(cache.unverified.size).toBe(0)
  })

  it('removes only failure markers absent from the successful listing', async () => {
    addEntry('removed')
    addEntry('pending')
    const cache = createWorktreeHeadIdentityCache()
    fake.failures.add(entryFile('removed', 'gitdir'))
    fake.failures.add(entryFile('pending', 'gitdir'))
    await readGitCommonHeadIdentities(COMMON, cache)
    fake.names.delete('removed')

    const result = await readGitCommonHeadIdentities(COMMON, cache, LISTING_HEAD_IDENTITY_SCOPE)

    expect(result.complete).toBe(false)
    expect([...cache.unverified]).toEqual(['pending'])
  })

  it('reads a reused admin-entry name after its failed predecessor was removed', async () => {
    addEntry('reused')
    const cache = createWorktreeHeadIdentityCache()
    fake.failures.add(entryFile('reused', 'HEAD'))
    await readGitCommonHeadIdentities(COMMON, cache)
    fake.names.delete('reused')
    await readGitCommonHeadIdentities(COMMON, cache, LISTING_HEAD_IDENTITY_SCOPE)
    fake.failures.clear()
    addEntry('reused', NEW_OID)

    const result = await readGitCommonHeadIdentities(
      COMMON,
      cache,
      headIdentityScopeForEntry('reused')
    )

    expect(result.complete).toBe(true)
    expect(cache.entries.get('reused')?.head).toBe(NEW_OID)
  })

  it('does not retain historical failures after twenty confirmed removals', async () => {
    const cache = createWorktreeHeadIdentityCache()
    for (let index = 0; index < 20; index++) {
      const name = `removed-${index}`
      addEntry(name)
      fake.failures.add(entryFile(name, 'HEAD'))
      await readGitCommonHeadIdentities(COMMON, cache, FULL_HEAD_IDENTITY_SCOPE)
      fake.names.delete(name)
      await readGitCommonHeadIdentities(COMMON, cache, LISTING_HEAD_IDENTITY_SCOPE)
    }

    expect(cache.unverified.size).toBe(0)
    expect((await readGitCommonHeadIdentities(COMMON, cache)).complete).toBe(true)
  })

  it('keeps retirement scoped to the cache that received a successful listing', async () => {
    addEntry('pending')
    fake.failures.add(entryFile('pending', 'HEAD'))
    const first = createWorktreeHeadIdentityCache()
    const second = createWorktreeHeadIdentityCache()
    await readGitCommonHeadIdentities(COMMON, first)
    await readGitCommonHeadIdentities(COMMON, second)
    fake.names.clear()

    await readGitCommonHeadIdentities(COMMON, first, LISTING_HEAD_IDENTITY_SCOPE)

    expect(first.unverified.size).toBe(0)
    expect([...second.unverified]).toEqual(['pending'])
  })

  it('restores scoped refresh costs and drops retired baseline rows after recovery', async () => {
    for (let index = 0; index < 8; index++) {
      addEntry(`live-${index}`)
    }
    addEntry('retired')
    const state = createWorktreeHeadIdentityRefreshState()
    const host: Parameters<typeof refreshWorktreeHeadIdentities>[0] = {
      path: COMMON,
      repos: new Map([['repo', {}]]),
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Refresh reads only isDestroyed; the window notifier is mocked.
      mainWindow: { isDestroyed: () => false } as never,
      disposed: false
    }
    try {
      await refreshWorktreeHeadIdentities(host, state, false)
      fake.failures.add(entryFile('retired', 'HEAD'))
      await refreshWorktreeHeadIdentities(host, state, true, headIdentityScopeForEntry('retired'))
      fake.names.delete('retired')
      vi.setSystemTime(1_061_000)
      await refreshWorktreeHeadIdentities(host, state, false, FULL_HEAD_IDENTITY_SCOPE)
      fake.readFile.mockClear()
      fake.readdir.mockClear()

      for (let index = 0; index < 4; index++) {
        await refreshWorktreeHeadIdentities(host, state, true, headIdentityScopeForEntry('live-0'))
      }

      expect(fake.readFile).toHaveBeenCalledTimes(8)
      expect(fake.readdir).not.toHaveBeenCalled()
      expect(state.cache.unverified.size).toBe(0)
      expect(state.baseline?.size).toBe(9)
      expect(state.baseline?.has(worktreePath('retired'))).toBe(false)
    } finally {
      disposeWorktreeHeadIdentityRefreshState(state)
    }
  })
})
