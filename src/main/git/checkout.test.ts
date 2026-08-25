import { beforeEach, describe, expect, it, vi } from 'vitest'

const { gitExecFileAsyncMock } = vi.hoisted(() => ({
  gitExecFileAsyncMock: vi.fn()
}))

vi.mock('./runner', () => ({
  gitExecFileAsync: gitExecFileAsyncMock,
  gitExecFileAsyncBuffer: vi.fn()
}))

import { checkoutBranch, createAndCheckoutBranch, listLocalBranches } from './checkout'

describe('checkoutBranch', () => {
  beforeEach(() => {
    gitExecFileAsyncMock.mockReset()
    gitExecFileAsyncMock.mockResolvedValue({ stdout: '', stderr: '' })
  })

  it('ends the argv with -- so the branch can never be read as a pathspec', async () => {
    await checkoutBranch('/repo', 'feature/login')

    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(['checkout', 'feature/login', '--'], {
      cwd: '/repo'
    })
  })

  it('refuses a flag-shaped branch name before spawning git', async () => {
    await expect(checkoutBranch('/repo', '--upload-pack=evil')).rejects.toThrow(
      'invalid_branch_name'
    )
    expect(gitExecFileAsyncMock).not.toHaveBeenCalled()
  })

  it('propagates git refusing to clobber uncommitted work', async () => {
    gitExecFileAsyncMock.mockRejectedValue(
      new Error('error: Your local changes would be overwritten by checkout')
    )

    await expect(checkoutBranch('/repo', 'main')).rejects.toThrow('would be overwritten')
  })
})

describe('createAndCheckoutBranch', () => {
  beforeEach(() => {
    gitExecFileAsyncMock.mockReset()
    gitExecFileAsyncMock.mockResolvedValue({ stdout: '', stderr: '' })
  })

  it('creates the branch at HEAD and switches to it', async () => {
    await createAndCheckoutBranch('/repo', 'feature/new')

    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(['checkout', '-b', 'feature/new', '--'], {
      cwd: '/repo'
    })
  })

  it('applies the full ref-format rules to a user-typed name', async () => {
    await expect(createAndCheckoutBranch('/repo', 'bad..name')).rejects.toThrow(
      'invalid_branch_name'
    )
    expect(gitExecFileAsyncMock).not.toHaveBeenCalled()
  })

  it('lets git report a name that already exists rather than switching to it', async () => {
    gitExecFileAsyncMock.mockRejectedValue(
      new Error("fatal: a branch named 'main' already exists")
    )

    await expect(createAndCheckoutBranch('/repo', 'main')).rejects.toThrow('already exists')
  })
})

describe('listLocalBranches', () => {
  beforeEach(() => {
    gitExecFileAsyncMock.mockReset()
  })

  it('returns the parsed listing including which worktree holds each branch', async () => {
    gitExecFileAsyncMock.mockResolvedValue({
      stdout: '*\tmain\t/repos/app\n\tfeature\t/repos/app-feature\n\tidle\t\n',
      stderr: ''
    })

    const listing = await listLocalBranches('/repo')

    expect(listing.current).toBe('main')
    expect(listing.entries).toEqual([
      { name: 'main', worktreePath: '/repos/app' },
      { name: 'feature', worktreePath: '/repos/app-feature' },
      { name: 'idle' }
    ])
  })
})
