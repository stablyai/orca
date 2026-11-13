import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const wslUncDirectoryExistsAsyncMock = vi.hoisted(() => vi.fn())

vi.mock('../../wsl/filesystem/unc-path-access', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return { ...actual, wslUncDirectoryExistsAsync: wslUncDirectoryExistsAsyncMock }
})

import {
  validateWorkingDirectoryAsync,
  _resetWorkingDirectoryValidationStateForTest
} from './validation'

beforeEach(() => {
  wslUncDirectoryExistsAsyncMock.mockReset()
  wslUncDirectoryExistsAsyncMock.mockResolvedValue(null)
  _resetWorkingDirectoryValidationStateForTest()
})

describe('validateWorkingDirectoryAsync', () => {
  describe('cancellation', () => {
    // Unsettled probes persist in the module-level dedupe map; use a distinct path per test.
    const deadShare = (name: string): string => `\\\\wsl.localhost\\Ubuntu\\dead-${name}`

    beforeEach(() => {
      vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    })

    afterEach(() => {
      vi.restoreAllMocks()
    })

    it('leaves the shared probe intact for callers that are still waiting', async () => {
      let releaseProbe: () => void = () => {}
      wslUncDirectoryExistsAsyncMock.mockReturnValue(
        new Promise<boolean>((resolve) => {
          releaseProbe = () => resolve(true)
        })
      )
      const abort = new AbortController()

      const shared = deadShare('shared')
      const staying = validateWorkingDirectoryAsync(shared)
      const leaving = validateWorkingDirectoryAsync(shared, { signal: abort.signal })
      abort.abort()
      await expect(leaving).rejects.toThrow('was canceled')

      releaseProbe()
      await expect(staying).resolves.toBeUndefined()
      expect(wslUncDirectoryExistsAsyncMock).toHaveBeenCalledOnce()
    })
  })
})
