import { describe, expect, it, vi } from 'vitest'
import { WindowsUserPathRegistryReader } from './windows-user-path-registry'

function registryModule(pathValue?: string, type = 2) {
  return {
    HK: { CU: 0x80000001, LM: 0x80000002 },
    REG: { SZ: 1, EXPAND_SZ: 2 },
    getRegistryKey: vi.fn(() =>
      pathValue === undefined ? {} : { Path: { name: 'Path', type, value: pathValue } }
    )
  }
}

describe('WindowsUserPathRegistryReader', () => {
  it('distinguishes a missing Path value from a registry read failure', async () => {
    const missingReader = new WindowsUserPathRegistryReader({
      platform: 'win32',
      registryLoader: async () => registryModule()
    })
    const failedReader = new WindowsUserPathRegistryReader({
      platform: 'win32',
      registryLoader: async () => {
        throw new Error('native addon unavailable')
      }
    })

    await expect(missingReader.read()).resolves.toEqual({
      state: 'success',
      value: null,
      expandable: false
    })
    await expect(failedReader.read()).resolves.toMatchObject({ state: 'unknown' })
  })

  it('coalesces concurrent reads, caches status reads, and bypasses the cache when fresh', async () => {
    let now = 100
    let resolveRegistry!: (value: ReturnType<typeof registryModule>) => void
    const registryLoader = vi.fn(
      () =>
        new Promise<ReturnType<typeof registryModule>>((resolve) => {
          resolveRegistry = resolve
        })
    )
    const reader = new WindowsUserPathRegistryReader({
      platform: 'win32',
      registryLoader,
      now: () => now,
      cacheTtlMs: 1_000
    })

    const first = reader.read()
    const concurrent = reader.read()
    expect(registryLoader).toHaveBeenCalledOnce()
    resolveRegistry(registryModule('C:\\Tools'))
    await expect(Promise.all([first, concurrent])).resolves.toEqual([
      { state: 'success', value: 'C:\\Tools', expandable: true },
      { state: 'success', value: 'C:\\Tools', expandable: true }
    ])

    await reader.read()
    expect(registryLoader).toHaveBeenCalledOnce()

    now += 1
    const refreshed = reader.readFresh()
    expect(registryLoader).toHaveBeenCalledTimes(2)
    resolveRegistry(registryModule('C:\\Tools;C:\\Orca'))
    await expect(refreshed).resolves.toEqual({
      state: 'success',
      value: 'C:\\Tools;C:\\Orca',
      expandable: true
    })
  })

  it.each([
    { type: 1, expandable: false },
    { type: 2, expandable: true }
  ])('preserves whether registry type $type expands variables', async ({ type, expandable }) => {
    const reader = new WindowsUserPathRegistryReader({
      platform: 'win32',
      registryLoader: async () => registryModule('%LOCALAPPDATA%\\Orca', type)
    })

    await expect(reader.read()).resolves.toEqual({
      state: 'success',
      value: '%LOCALAPPDATA%\\Orca',
      expandable
    })
  })
})
