import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { ghExecFileAsyncMock } = vi.hoisted(() => ({
  ghExecFileAsyncMock: vi.fn()
}))

vi.mock('../git/runner', () => ({
  ghExecFileAsync: ghExecFileAsyncMock
}))

import {
  clearGhCapabilityStateForTests,
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
