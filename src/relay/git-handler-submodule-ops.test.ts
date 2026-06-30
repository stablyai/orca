import { describe, expect, it } from 'vitest'
import * as path from 'node:path'
import type { GitExec } from './git-handler-ops'
import {
  SUBMODULE_PATHS_CACHE_TTL_MS,
  createSubmodulePathsCache,
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
