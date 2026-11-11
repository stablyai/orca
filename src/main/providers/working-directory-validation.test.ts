import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const wslUncDirectoryExistsAsyncMock = vi.hoisted(() => vi.fn())

vi.mock('../wsl/filesystem/unc-path-access', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return { ...actual, wslUncDirectoryExistsAsync: wslUncDirectoryExistsAsyncMock }
})

import {
  validateWorkingDirectoryAsync,
  _resetWorkingDirectoryValidationStateForTest
} from './working-directory-validation'

let tempDir: string

beforeEach(async () => {
  wslUncDirectoryExistsAsyncMock.mockReset()
  wslUncDirectoryExistsAsyncMock.mockResolvedValue(null)
  _resetWorkingDirectoryValidationStateForTest()
  tempDir = await mkdtemp(path.join(os.tmpdir(), 'orca-cwd-validate-'))
})

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true })
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

  describe('UNC route concurrency', () => {
    beforeEach(() => {
      vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    })

    afterEach(() => {
      vi.restoreAllMocks()
    })

    it('keeps a healthy local path out of a stalled share queue', async () => {
      wslUncDirectoryExistsAsyncMock.mockReturnValue(new Promise<boolean>(() => {}))
      for (let index = 0; index < 4; index += 1) {
        void validateWorkingDirectoryAsync(`\\\\wsl.localhost\\Ubuntu\\blocking-${index}`).catch(
          () => {}
        )
      }

      await expect(validateWorkingDirectoryAsync(tempDir)).resolves.toBeUndefined()
    })
  })
})
