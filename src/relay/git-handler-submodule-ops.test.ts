import { describe, expect, it } from 'vitest'
import * as path from 'node:path'
import type { GitExec } from './git-handler-ops'
import {
  MAX_SUBMODULE_PATH_CODE_UNITS,
  MAX_SUBMODULE_PATHS_CACHE_CODE_UNITS,
  MAX_SUBMODULE_PATHS_CACHE_ENTRIES,
  MAX_SUBMODULE_PATHS_CACHE_KEY_BYTES,
  MAX_SUBMODULE_PATHS_OUTPUT_BYTES,
  MAX_SUBMODULE_PATHS_PER_REPO,
  MAX_SUBMODULE_PATHS_PER_REPO_CODE_UNITS,
  SUBMODULE_PATHS_CACHE_TTL_MS,
  clearSubmodulePathsCache,
  createSubmodulePathsCache,
  getSubmodulePathsCacheCodeUnits,
  getSubmodulePathsCacheCount,
  listSubmodulePaths,
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

function pathsUsingCodeUnits(codeUnits: number): string[] {
  const fullPath = 'x'.repeat(MAX_SUBMODULE_PATH_CODE_UNITS)
  const paths = Array.from(
    { length: Math.floor(codeUnits / MAX_SUBMODULE_PATH_CODE_UNITS) },
    () => fullPath
  )
  const remainder = codeUnits % MAX_SUBMODULE_PATH_CODE_UNITS
  if (remainder > 0) {
    paths.push('x'.repeat(remainder))
  }
  return paths
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

  it('keeps the existing 10 MiB command-output ceiling explicit', async () => {
    let receivedOptions: Parameters<GitExec>[2]
    const git: GitExec = async (_args, _cwd, options) => {
      receivedOptions = options
      return { stdout: 'submodule.lib.path vendor/lib\n', stderr: '' }
    }

    await listSubmodulePaths(git, '/repo')

    expect(receivedOptions).toEqual({ maxBuffer: MAX_SUBMODULE_PATHS_OUTPUT_BYTES })
    expect(MAX_SUBMODULE_PATHS_OUTPUT_BYTES).toBe(10 * 1024 * 1024)
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
    expect(getSubmodulePathsCacheCodeUnits(cache)).toBe('/repo-c'.length + 'vendor/lib'.length)
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

  it('does not retain worktree keys above the UTF-8 byte ceiling', async () => {
    const exact = gitmodulesExec(['vendor/lib'])
    const exactCache = createSubmodulePathsCache()
    const exactKey = 'r'.repeat(MAX_SUBMODULE_PATHS_CACHE_KEY_BYTES)

    await listSubmodulePathsCached(exact.git, exactKey, exactCache, 1_000)
    await listSubmodulePathsCached(exact.git, exactKey, exactCache, 1_001)

    expect(exact.calls()).toBe(1)
    expect(getSubmodulePathsCacheCount(exactCache)).toBe(1)

    const overflow = gitmodulesExec(['vendor/lib'])
    const overflowCache = createSubmodulePathsCache()
    const overflowKey = '界'.repeat(Math.floor(MAX_SUBMODULE_PATHS_CACHE_KEY_BYTES / 3) + 1)
    expect(Buffer.byteLength(overflowKey, 'utf8')).toBeGreaterThan(
      MAX_SUBMODULE_PATHS_CACHE_KEY_BYTES
    )

    await listSubmodulePathsCached(overflow.git, overflowKey, overflowCache, 1_000)
    await listSubmodulePathsCached(overflow.git, overflowKey, overflowCache, 1_001)

    expect(overflow.calls()).toBe(2)
    expect(getSubmodulePathsCacheCount(overflowCache)).toBe(0)
    expect(getSubmodulePathsCacheCodeUnits(overflowCache)).toBe(0)
  })

  it('evicts LRU payloads above the global retained-code-unit ceiling and recovers', async () => {
    const calls = new Map<string, number>()
    const git: GitExec = async (_args, cwd) => {
      calls.set(cwd, (calls.get(cwd) ?? 0) + 1)
      const paths =
        cwd === '/overflow'
          ? ['vendor/lib']
          : pathsUsingCodeUnits(MAX_SUBMODULE_PATHS_PER_REPO_CODE_UNITS - cwd.length)
      return {
        stdout: paths
          .map((submodulePath, i) => `submodule.sub${i}.path ${submodulePath}`)
          .join('\n'),
        stderr: ''
      }
    }
    const cache = createSubmodulePathsCache()

    for (let i = 0; i < 4; i += 1) {
      await listSubmodulePathsCached(git, `/repo-${i}`, cache, 1_000)
    }
    expect(getSubmodulePathsCacheCodeUnits(cache)).toBe(MAX_SUBMODULE_PATHS_CACHE_CODE_UNITS)

    await listSubmodulePathsCached(git, '/overflow', cache, 1_000)

    expect(getSubmodulePathsCacheCount(cache)).toBe(4)
    expect(getSubmodulePathsCacheCodeUnits(cache)).toBeLessThan(
      MAX_SUBMODULE_PATHS_CACHE_CODE_UNITS
    )
    await listSubmodulePathsCached(git, '/repo-1', cache, 1_001)
    expect(calls.get('/repo-1')).toBe(1)
    await listSubmodulePathsCached(git, '/repo-0', cache, 1_001)
    expect(calls.get('/repo-0')).toBe(2)
    expect(getSubmodulePathsCacheCodeUnits(cache)).toBeLessThanOrEqual(
      MAX_SUBMODULE_PATHS_CACHE_CODE_UNITS
    )
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
    expect(getSubmodulePathsCacheCodeUnits(cache)).toBe(0)
    resolveOldRead?.({ stdout: 'submodule.lib.path old-lib\n', stderr: '' })

    await expect(oldRead).resolves.toEqual(['old-lib'])
    expect(getSubmodulePathsCacheCount(cache)).toBe(0)
    await expect(listSubmodulePathsCached(git, '/repo', cache, 1_001)).resolves.toEqual([
      'fresh-lib'
    ])
    expect(calls).toBe(2)
  })
})

describe('listSubmodulePaths', () => {
  it('preserves the exact path-count boundary and rejects one more', async () => {
    const exactPaths = Array.from(
      { length: MAX_SUBMODULE_PATHS_PER_REPO },
      (_, index) => `vendor/lib-${index}`
    )
    const exact = await listSubmodulePaths(gitmodulesExec(exactPaths).git, '/repo')
    const overflow = await listSubmodulePaths(
      gitmodulesExec([...exactPaths, 'vendor/overflow']).git,
      '/repo'
    )

    expect(exact).toHaveLength(MAX_SUBMODULE_PATHS_PER_REPO)
    expect(exact.at(-1)).toBe(`vendor/lib-${MAX_SUBMODULE_PATHS_PER_REPO - 1}`)
    expect(overflow).toEqual([])
  })

  it('preserves the exact per-path boundary and rejects one more code unit', async () => {
    const exactPath = 'x'.repeat(MAX_SUBMODULE_PATH_CODE_UNITS)

    await expect(listSubmodulePaths(gitmodulesExec([exactPath]).git, '/repo')).resolves.toEqual([
      exactPath
    ])
    await expect(
      listSubmodulePaths(gitmodulesExec([`${exactPath}x`]).git, '/repo')
    ).resolves.toEqual([])
  })

  it('preserves the exact per-repo payload boundary and rejects one more code unit', async () => {
    const exactPaths = pathsUsingCodeUnits(MAX_SUBMODULE_PATHS_PER_REPO_CODE_UNITS)
    const exact = await listSubmodulePaths(gitmodulesExec(exactPaths).git, '/repo')
    const overflow = await listSubmodulePaths(gitmodulesExec([...exactPaths, 'x']).git, '/repo')

    expect(exact.reduce((total, submodulePath) => total + submodulePath.length, 0)).toBe(
      MAX_SUBMODULE_PATHS_PER_REPO_CODE_UNITS
    )
    expect(overflow).toEqual([])
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
