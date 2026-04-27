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
})
