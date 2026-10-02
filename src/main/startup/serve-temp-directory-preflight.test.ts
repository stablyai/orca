import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ServeTempDirectoryError } from '../../shared/serve-temp-directory'
import type * as ServeTempDirectoryModule from '../../shared/serve-temp-directory'
import { SERVE_SUPERVISOR_STOP_EXIT_CODE } from '../../shared/serve-supervision'
import { validateServeTempDirectory } from './serve-temp-directory-preflight'

const { prepare, exit } = vi.hoisted(() => ({ prepare: vi.fn(), exit: vi.fn() }))
vi.mock('electron', () => ({ app: { exit } }))
vi.mock('../../shared/serve-temp-directory', async (importOriginal) => ({
  ...(await importOriginal<typeof ServeTempDirectoryModule>()),
  prepareServeTempDirectory: prepare
}))

beforeEach(() => {
  vi.restoreAllMocks()
  prepare.mockReset()
  exit.mockReset()
})

describe('serve temporary-directory preflight', () => {
  it('continues startup when the real directory validator succeeds', () => {
    prepare.mockReturnValue('/validated-temp')
    expect(validateServeTempDirectory()).toBe(true)
    expect(prepare).toHaveBeenCalledOnce()
    expect(exit).not.toHaveBeenCalled()
  })

  it('stops startup without restart for a typed temporary-directory failure', () => {
    prepare.mockImplementation(() => {
      throw new ServeTempDirectoryError('/unavailable-temp', 'ENOSPC', 'full')
    })
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    expect(validateServeTempDirectory()).toBe(false)
    expect(exit).toHaveBeenCalledExactlyOnceWith(SERVE_SUPERVISOR_STOP_EXIT_CODE)
  })

  it('propagates unrelated errors without classifying them as a directory failure', () => {
    const error = new Error('unexpected startup failure')
    prepare.mockImplementation(() => {
      throw error
    })
    expect(validateServeTempDirectory).toThrow(error)
    expect(exit).not.toHaveBeenCalled()
  })
})
