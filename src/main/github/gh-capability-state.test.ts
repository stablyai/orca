import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { ghExecFileAsyncMock } = vi.hoisted(() => ({
  ghExecFileAsyncMock: vi.fn()
}))

vi.mock('../git/runner', () => ({
  ghExecFileAsync: ghExecFileAsyncMock
}))

import {
  clearGhCapabilityStateForTests,
  getGhExecutionHostKey,
  getGhMultiAccountCapability,
  invalidateGhMultiAccountCapability
} from './gh-capability-state'

describe('gh-capability-state', () => {
  beforeEach(() => {
    clearGhCapabilityStateForTests()
    ghExecFileAsyncMock.mockReset()
  })

  afterEach(() => {
    clearGhCapabilityStateForTests()
  })

  it('keys local vs wsl execution hosts', () => {
    expect(getGhExecutionHostKey({})).toBe('local')
    expect(getGhExecutionHostKey({ wslDistro: 'Ubuntu' })).toBe('wsl:Ubuntu')
  })

  it('reports supported when help lists --user', async () => {
    ghExecFileAsyncMock.mockResolvedValue({
      stdout: 'Usage: gh auth token [--user login]',
      stderr: ''
    })
    await expect(getGhMultiAccountCapability()).resolves.toBe('supported')
    expect(ghExecFileAsyncMock).toHaveBeenCalledWith(
      ['auth', 'token', '--help'],
      expect.objectContaining({ timeout: 10_000 })
    )
  })

  it('reports unsupported when help omits --user', async () => {
    ghExecFileAsyncMock.mockResolvedValue({
      stdout: 'Usage: gh auth token',
      stderr: ''
    })
    await expect(getGhMultiAccountCapability({ wslDistro: 'Ubuntu' })).resolves.toBe('unsupported')
  })

  it('caches per runtime and invalidates on request', async () => {
    ghExecFileAsyncMock.mockResolvedValue({
      stdout: 'Usage: gh auth token [--user login]',
      stderr: ''
    })
    await getGhMultiAccountCapability({ wslDistro: 'Ubuntu' })
    await getGhMultiAccountCapability({ wslDistro: 'Ubuntu' })
    expect(ghExecFileAsyncMock).toHaveBeenCalledTimes(1)

    invalidateGhMultiAccountCapability({ wslDistro: 'Ubuntu' })
    await getGhMultiAccountCapability({ wslDistro: 'Ubuntu' })
    expect(ghExecFileAsyncMock).toHaveBeenCalledTimes(2)
  })
})
