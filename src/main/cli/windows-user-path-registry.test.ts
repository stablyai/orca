import { describe, expect, it, vi } from 'vitest'
import {
  invalidateWindowsUserPathRegistryCache,
  readWindowsUserPathRegistry,
  WindowsUserPathRegistryReader
} from './windows-user-path-registry'

function registryModule(pathValue?: string, type = 2) {
  return {
    HK: { CU: 0x80000001 },
    REG: { SZ: 1, EXPAND_SZ: 2 },
    getRegistryKey: vi.fn(() =>
      pathValue === undefined ? {} : { Path: { name: 'Path', type, value: pathValue } }
    )
  }
}

describe('WindowsUserPathRegistryReader', () => {
  it('reads Unicode REG_EXPAND_SZ values without expanding the stored text', async () => {
    const registry = registryModule('%LOCALAPPDATA%\\Orca;C:\\工具\\bin;C:\\Développement')
    const reader = new WindowsUserPathRegistryReader({
      platform: 'win32',
      registryLoader: async () => registry
    })

    await expect(reader.read()).resolves.toEqual({
      state: 'success',
      value: '%LOCALAPPDATA%\\Orca;C:\\工具\\bin;C:\\Développement',
      expandable: true
    })
    expect(registry.getRegistryKey).toHaveBeenCalledWith(0x80000001, 'Environment')
  })

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

  it('does not load the Windows-only dependency on other platforms', async () => {
    const registryLoader = vi.fn(async () => registryModule('C:\\Tools'))
    const reader = new WindowsUserPathRegistryReader({
      platform: 'linux',
      registryLoader
    })

    await expect(reader.read()).resolves.toMatchObject({ state: 'unknown' })
    expect(registryLoader).not.toHaveBeenCalled()
  })

  it.runIf(process.platform === 'win32')(
    'loads the real native addon and reads the current Windows user PATH',
    async () => {
      invalidateWindowsUserPathRegistryCache()
      await expect(readWindowsUserPathRegistry()).resolves.toMatchObject({ state: 'success' })
    }
  )
})
