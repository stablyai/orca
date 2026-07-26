import { beforeEach, describe, expect, it, vi } from 'vitest'

const { gitExecFileAsyncMock } = vi.hoisted(() => ({
  gitExecFileAsyncMock: vi.fn()
}))

vi.mock('./runner', () => ({
  gitExecFileAsync: gitExecFileAsyncMock,
  gitExecFileSync: vi.fn()
}))

import { getBaseRefDefault } from './repo'

describe('getBaseRefDefault async subprocess bounds', () => {
  beforeEach(() => {
    gitExecFileAsyncMock.mockReset()
  })

  it('bounds every local probe and degrades a timeout to no default', async () => {
    gitExecFileAsyncMock.mockRejectedValue(new Error('git timed out.'))

    await expect(getBaseRefDefault('/repo')).resolves.toBeNull()

    expect(gitExecFileAsyncMock).toHaveBeenCalled()
    for (const [, options] of gitExecFileAsyncMock.mock.calls) {
      expect(options).toEqual({ cwd: '/repo', timeout: 15_000 })
    }
  })

  it('preserves the same timeout when routing probes through WSL', async () => {
    gitExecFileAsyncMock.mockRejectedValue(new Error('git timed out.'))

    await expect(
      getBaseRefDefault('\\\\wsl.localhost\\Ubuntu\\repo', { wslDistro: 'Ubuntu' })
    ).resolves.toBeNull()

    expect(gitExecFileAsyncMock).toHaveBeenCalled()
    for (const [, options] of gitExecFileAsyncMock.mock.calls) {
      expect(options).toEqual({
        cwd: '\\\\wsl.localhost\\Ubuntu\\repo',
        timeout: 15_000,
        wslDistro: 'Ubuntu'
      })
    }
  })
})
