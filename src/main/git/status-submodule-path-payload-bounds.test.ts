import { beforeEach, describe, expect, it, vi } from 'vitest'

const { gitExecFileAsyncMock } = vi.hoisted(() => ({ gitExecFileAsyncMock: vi.fn() }))

vi.mock('./runner', () => ({
  gitExecFileAsync: gitExecFileAsyncMock,
  gitOptionalLocksDisabledEnv: (env: NodeJS.ProcessEnv = process.env) => ({
    ...env,
    GIT_OPTIONAL_LOCKS: '0'
  })
}))

import {
  clearSubmodulePathsCacheForTests,
  getSubmodulePathsCacheCodeUnitsForTests,
  getSubmodulePathsCacheCountForTests,
  listSubmodulePaths,
  MAX_SUBMODULE_PATH_CODE_UNITS,
  MAX_SUBMODULE_PATHS_CACHE_CODE_UNITS,
  MAX_SUBMODULE_PATHS_PER_REPO
} from './status'

describe('submodule path payload bounds', () => {
  beforeEach(() => {
    clearSubmodulePathsCacheForTests()
    gitExecFileAsyncMock.mockReset()
  })

  it('preserves under-limit path order and cache reuse', async () => {
    gitExecFileAsyncMock.mockResolvedValue({
      stdout: 'submodule.one.path packages/one\nsubmodule.two.path packages/two/\n'
    })

    await expect(listSubmodulePaths('/repo')).resolves.toEqual(['packages/one', 'packages/two'])
    await expect(listSubmodulePaths('/repo')).resolves.toEqual(['packages/one', 'packages/two'])
    expect(gitExecFileAsyncMock).toHaveBeenCalledOnce()
  })

  it('fails closed above the per-repository path count', async () => {
    gitExecFileAsyncMock.mockResolvedValue({
      stdout: Array.from(
        { length: MAX_SUBMODULE_PATHS_PER_REPO + 1 },
        (_, index) => `submodule.s${index}.path modules/${index}\n`
      ).join('')
    })

    await expect(listSubmodulePaths('/repo')).resolves.toEqual([])
  })

  it('fails closed on a single oversized path', async () => {
    gitExecFileAsyncMock.mockResolvedValue({
      stdout: `submodule.large.path ${'x'.repeat(MAX_SUBMODULE_PATH_CODE_UNITS + 1)}\n`
    })

    await expect(listSubmodulePaths('/repo')).resolves.toEqual([])
  })

  it('evicts old payloads at the aggregate retained-code-unit budget', async () => {
    const segment = 'x'.repeat(60 * 1024)
    const stdout = Array.from(
      { length: 16 },
      (_, index) => `submodule.s${index}.path ${segment}${index}\n`
    ).join('')
    gitExecFileAsyncMock.mockResolvedValue({ stdout })

    for (let index = 0; index < 18; index += 1) {
      await listSubmodulePaths(`/repo-${index}`)
    }

    expect(getSubmodulePathsCacheCodeUnitsForTests()).toBeLessThanOrEqual(
      MAX_SUBMODULE_PATHS_CACHE_CODE_UNITS
    )
    expect(getSubmodulePathsCacheCountForTests()).toBeLessThan(18)
  })

  it('does not retain an oversized cache key', async () => {
    gitExecFileAsyncMock.mockResolvedValue({ stdout: 'submodule.one.path packages/one\n' })
    const worktreePath = `/${'r'.repeat(64 * 1024)}`

    await listSubmodulePaths(worktreePath)
    await listSubmodulePaths(worktreePath)

    expect(gitExecFileAsyncMock).toHaveBeenCalledTimes(2)
    expect(getSubmodulePathsCacheCountForTests()).toBe(0)
    expect(getSubmodulePathsCacheCodeUnitsForTests()).toBe(0)
  })
})
