import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  __setWindowsPathRegistryLoaderForTests,
  readWindowsPathRegistry
} from './windows-path-registry-reader'

describe('readWindowsPathRegistry', () => {
  afterEach(() => __setWindowsPathRegistryLoaderForTests())

  it('reads machine and user PATH values without creating a process', () => {
    const getRegistryKey = vi
      .fn()
      .mockReturnValueOnce({ PATH: { type: 2, value: '%SystemRoot%\\System32' } })
      .mockReturnValueOnce({ Path: { type: 1, value: 'C:\\Users\\me\\bin' } })
    __setWindowsPathRegistryLoaderForTests(() => ({
      HK: { LM: 1, CU: 2 },
      getRegistryKey
    }))

    expect(readWindowsPathRegistry()).toEqual([
      { failed: false, value: '%SystemRoot%\\System32' },
      { failed: false, value: 'C:\\Users\\me\\bin' }
    ])
    expect(getRegistryKey).toHaveBeenNthCalledWith(
      1,
      1,
      'SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment'
    )
    expect(getRegistryKey).toHaveBeenNthCalledWith(2, 2, 'Environment')
  })

  it('distinguishes an empty PATH from a failed registry read', () => {
    const getRegistryKey = vi
      .fn()
      .mockReturnValueOnce({ Path: { type: 1, value: '' } })
      .mockReturnValueOnce({ Path: { type: 4, value: 1 } })
    __setWindowsPathRegistryLoaderForTests(() => ({
      HK: { LM: 1, CU: 2 },
      getRegistryKey
    }))

    expect(readWindowsPathRegistry()).toEqual([
      { failed: false, value: '' },
      { failed: true, value: null }
    ])
  })

  it('treats a missing PATH value as a failed query', () => {
    __setWindowsPathRegistryLoaderForTests(() => ({
      HK: { LM: 1, CU: 2 },
      getRegistryKey: vi.fn(() => ({}))
    }))

    expect(readWindowsPathRegistry()).toEqual([
      { failed: true, value: null },
      { failed: true, value: null }
    ])
  })

  it('fails closed when the optional native module is unavailable', () => {
    __setWindowsPathRegistryLoaderForTests(() => {
      throw new Error('native module unavailable')
    })

    expect(readWindowsPathRegistry()).toEqual([
      { failed: true, value: null },
      { failed: true, value: null }
    ])
  })
})
