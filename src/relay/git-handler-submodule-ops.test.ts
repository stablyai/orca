import { describe, expect, it } from 'vitest'
import * as path from 'node:path'
import type { GitExec } from './git-handler-ops'
import {
  MAX_SUBMODULE_PATHS_CACHE_ENTRIES,
  SUBMODULE_PATHS_CACHE_TTL_MS,
  clearSubmodulePathsCache,
  createSubmodulePathsCache,
  getSubmodulePathsCacheCount,
  listSubmodulePathsCached,
  resolveSubmoduleWorktreePath
} from './git-handler-submodule-ops'

function gitmodulesExec(paths: string[]): { git: GitExec; calls: () => number } {
  let calls = 0
  const git: GitExec = async (args) => {
    if (args[0] === 'config' && args.includes('.gitmodules')) {
      calls += 1
      return {
        stdout: paths.map((p, i) => `submodule.sub${i}.path ${p}`).join('\n'),
        stderr: ''
      }
    }
    return { stdout: '', stderr: '' }
  }
  return { git, calls: () => calls }
}

describe('listSubmodulePathsCached', () => {
  it('reads .gitmodules once for repeated diffs on the same worktree within TTL', async () => {
    const { git, calls } = gitmodulesExec(['vendor/lib'])
    const cache = createSubmodulePathsCache()

    const first = await listSubmodulePathsCached(git, '/repo', cache, 1_000)
    const second = await listSubmodulePathsCached(git, '/repo', cache, 1_500)

    expect(first).toEqual(['vendor/lib'])
    expect(second).toEqual(['vendor/lib'])
    expect(calls()).toBe(1)
  })

  it('re-reads after the TTL expires', async () => {
    const { git, calls } = gitmodulesExec(['vendor/lib'])
    const cache = createSubmodulePathsCache()

    await listSubmodulePathsCached(git, '/repo', cache, 1_000)
    await listSubmodulePathsCached(git, '/repo', cache, 1_000 + SUBMODULE_PATHS_CACHE_TTL_MS + 1)

    expect(calls()).toBe(2)
  })

  it('reads separately for different worktrees', async () => {
    const { git, calls } = gitmodulesExec(['vendor/lib'])
    const cache = createSubmodulePathsCache()

    await listSubmodulePathsCached(git, '/repo-a', cache, 1_000)
    await listSubmodulePathsCached(git, '/repo-b', cache, 1_000)

    expect(calls()).toBe(2)
  })

  it('prunes expired entries when a different remote worktree misses', async () => {
    const { git } = gitmodulesExec(['vendor/lib'])
    const cache = createSubmodulePathsCache()

    await listSubmodulePathsCached(git, '/repo-a', cache, 0)
    await listSubmodulePathsCached(git, '/repo-b', cache, 0)
    expect(getSubmodulePathsCacheCount(cache)).toBe(2)

    await listSubmodulePathsCached(git, '/repo-c', cache, SUBMODULE_PATHS_CACHE_TTL_MS + 1)
    expect(getSubmodulePathsCacheCount(cache)).toBe(1)
  })

  it('caches an empty result so a submodule-free repo is not re-read', async () => {
    let calls = 0
    const git: GitExec = async () => {
      calls += 1
      throw new Error('fatal: No such file or directory')
    }
    const cache = createSubmodulePathsCache()

    const first = await listSubmodulePathsCached(git, '/repo', cache, 1_000)
    const second = await listSubmodulePathsCached(git, '/repo', cache, 1_200)

    expect(first).toEqual([])
    expect(second).toEqual([])
    expect(calls).toBe(1)
  })

  it('stays bounded through prolonged remote-worktree churn and retains recent entries', async () => {
    const { git, calls } = gitmodulesExec(['vendor/lib'])
    const cache = createSubmodulePathsCache()
    let now = 0

    for (let wave = 0; wave < 4; wave += 1) {
      for (let i = 0; i < MAX_SUBMODULE_PATHS_CACHE_ENTRIES; i += 1) {
        await listSubmodulePathsCached(git, `/wave-${wave}-repo-${i}`, cache, now)
      }
      expect(getSubmodulePathsCacheCount(cache)).toBe(MAX_SUBMODULE_PATHS_CACHE_ENTRIES)
      now += SUBMODULE_PATHS_CACHE_TTL_MS + 1
    }

    await listSubmodulePathsCached(git, '/retained-repo', cache, now)
    for (let i = 0; i < MAX_SUBMODULE_PATHS_CACHE_ENTRIES - 1; i += 1) {
      await listSubmodulePathsCached(git, `/final-repo-${i}`, cache, now)
    }
    await listSubmodulePathsCached(git, '/retained-repo', cache, now)
    await listSubmodulePathsCached(
      git,
      `/final-repo-${MAX_SUBMODULE_PATHS_CACHE_ENTRIES - 1}`,
      cache,
      now
    )
    await listSubmodulePathsCached(git, '/overflow-repo', cache, now)

    expect(getSubmodulePathsCacheCount(cache)).toBe(MAX_SUBMODULE_PATHS_CACHE_ENTRIES)
    const callsBeforeReads = calls()
    await listSubmodulePathsCached(git, '/retained-repo', cache, now)
    expect(calls()).toBe(callsBeforeReads)
    await listSubmodulePathsCached(git, '/final-repo-0', cache, now)
    expect(calls()).toBe(callsBeforeReads + 1)
  })

  it('does not let a pre-mutation SSH read repopulate the cache', async () => {
    let resolveOldRead: ((value: { stdout: string; stderr: string }) => void) | undefined
    let calls = 0
    const git: GitExec = () => {
      calls += 1
      if (calls > 1) {
        return Promise.resolve({ stdout: 'submodule.lib.path fresh-lib\n', stderr: '' })
      }
      return new Promise((resolve) => {
        resolveOldRead = resolve
      })
    }
    const cache = createSubmodulePathsCache()

    const oldRead = listSubmodulePathsCached(git, '/repo', cache, 1_000)
    expect(resolveOldRead).toBeTypeOf('function')
    clearSubmodulePathsCache(cache)
    resolveOldRead?.({ stdout: 'submodule.lib.path old-lib\n', stderr: '' })

    await expect(oldRead).resolves.toEqual(['old-lib'])
    expect(getSubmodulePathsCacheCount(cache)).toBe(0)
    await expect(listSubmodulePathsCached(git, '/repo', cache, 1_001)).resolves.toEqual([
      'fresh-lib'
    ])
    expect(calls).toBe(2)
  })
})

describe('resolveSubmoduleWorktreePath', () => {
  it('resolves relative submodule paths inside the selected worktree', () => {
    expect(resolveSubmoduleWorktreePath('/repo', 'vendor/lib')).toBe(
      path.resolve('/repo', 'vendor/lib')
    )
  })

  it('rejects empty, absolute, null-byte, and escaping paths', () => {
    expect(() => resolveSubmoduleWorktreePath('/repo', '')).toThrow('Access denied')
    expect(() => resolveSubmoduleWorktreePath('/repo', path.resolve('/tmp/outside'))).toThrow(
      'Access denied'
    )
    expect(() => resolveSubmoduleWorktreePath('/repo', 'vendor\0lib')).toThrow('Access denied')
    expect(() => resolveSubmoduleWorktreePath('/repo', '../outside')).toThrow('Access denied')
  })
})
