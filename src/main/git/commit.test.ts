import { beforeEach, describe, expect, it, vi } from 'vitest'

const { gitExecFileAsyncMock } = vi.hoisted(() => ({
  gitExecFileAsyncMock: vi.fn()
}))

vi.mock('./runner', () => ({
  gitExecFileAsync: gitExecFileAsyncMock,
  gitExecFileAsyncBuffer: vi.fn()
}))

import { commitChanges } from './status'

describe('commitChanges', () => {
  beforeEach(() => {
    gitExecFileAsyncMock.mockReset()
  })

  it('returns success when git commit completes', async () => {
    gitExecFileAsyncMock.mockResolvedValue({ stdout: '[main abc123] message\n', stderr: '' })

    const result = await commitChanges('/repo', 'feat: add commit action')

    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(['commit', '-m', 'feat: add commit action'], {
      cwd: '/repo'
    })
    expect(result).toEqual({ success: true })
  })

  it('returns stderr when commit fails (e.g. pre-commit hook)', async () => {
    gitExecFileAsyncMock.mockRejectedValue({
      stderr: 'pre-commit hook failed: lint errors\n'
    })

    const result = await commitChanges('/repo', 'feat: commit with lint errors')

    expect(result).toEqual({
      success: false,
      error: 'pre-commit hook failed: lint errors\n'
    })
  })

  it('returns stdout when git writes to stdout (e.g. nothing to commit)', async () => {
    gitExecFileAsyncMock.mockRejectedValue({
      stdout: 'nothing to commit, working tree clean\n',
      stderr: ''
    })

    const result = await commitChanges('/repo', 'feat: empty commit')

    expect(result).toEqual({
      success: false,
      error: 'nothing to commit, working tree clean\n'
    })
  })

  it('prefers stderr over stdout when both are present', async () => {
    gitExecFileAsyncMock.mockRejectedValue({
      stdout: 'some stdout output\n',
      stderr: 'hook rejected\n'
    })

    const result = await commitChanges('/repo', 'feat: both channels')

    expect(result).toEqual({
      success: false,
      error: 'hook rejected\n'
    })
  })

  it('falls back to Error.message when stdout/stderr are empty', async () => {
    gitExecFileAsyncMock.mockRejectedValue(new Error('spawn git ENOENT'))

    const result = await commitChanges('/repo', 'feat: missing git')

    expect(result).toEqual({
      success: false,
      error: 'spawn git ENOENT'
    })
  })
})
