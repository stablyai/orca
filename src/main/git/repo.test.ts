import { describe, expect, it, vi, beforeEach } from 'vitest'

const { gitExecFileSyncMock } = vi.hoisted(() => ({
  gitExecFileSyncMock: vi.fn()
}))

vi.mock('./runner', () => ({
  gitExecFileSync: gitExecFileSyncMock,
  gitExecFileAsync: vi.fn()
}))

import { isBareRepo } from './repo'

describe('isBareRepo', () => {
  beforeEach(() => {
    gitExecFileSyncMock.mockReset()
  })

  it('returns true when git rev-parse reports the repo is bare', () => {
    gitExecFileSyncMock.mockReturnValue('true\n')
    expect(isBareRepo('/some/repo.git')).toBe(true)
    expect(gitExecFileSyncMock).toHaveBeenCalledWith(['rev-parse', '--is-bare-repository'], {
      cwd: '/some/repo.git'
    })
  })

  it('returns false when git rev-parse reports the repo is not bare', () => {
    gitExecFileSyncMock.mockReturnValue('false\n')
    expect(isBareRepo('/some/repo')).toBe(false)
  })

  it('returns false when git rev-parse throws', () => {
    // Why: not-a-git-repo and permission errors both throw. Treating either as
    // "not bare" is the safest default for callers that use this as a gate.
    gitExecFileSyncMock.mockImplementation(() => {
      throw new Error('not a git repository')
    })
    expect(isBareRepo('/not/a/repo')).toBe(false)
  })
})
