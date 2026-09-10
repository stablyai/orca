import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { platformApi } from './platform-bridge'

const mocks = vi.hoisted(() => ({ getLinuxDisplayServer: vi.fn(() => null) }))

vi.mock('../preload-runtime-support', () => ({
  getLinuxDisplayServer: mocks.getLinuxDisplayServer
}))

// Electron declares getSystemVersion as required on NodeJS.Process; Node does not have it.
const mutableProcess = process as unknown as { getSystemVersion?: () => string }

async function loadPlatformApi(): Promise<typeof platformApi> {
  vi.resetModules()
  return (await import('./platform-bridge')).platformApi
}

describe('platformApi.get', () => {
  beforeEach(() => {
    mocks.getLinuxDisplayServer.mockClear()
  })

  afterEach(() => {
    delete mutableProcess.getSystemVersion
  })

  it('resolves the immutable payload once and returns the identical object', async () => {
    const platformApi = await loadPlatformApi()
    const getSystemVersion = vi.fn(() => '25.3.0')
    mutableProcess.getSystemVersion = getSystemVersion

    const first = platformApi.get()
    for (let index = 0; index < 100; index += 1) {
      expect(platformApi.get()).toBe(first)
    }

    expect(getSystemVersion).toHaveBeenCalledTimes(1)
    expect(mocks.getLinuxDisplayServer).toHaveBeenCalledTimes(1)
    expect(first.platform).toBe(process.platform)
    expect(first.arch).toBe(process.arch)
    expect(first.osRelease).toBe('25.3.0')
  })

  it('freezes the payload so no consumer can corrupt the shared instance', async () => {
    const platformApi = await loadPlatformApi()

    expect(Object.isFrozen(platformApi.get())).toBe(true)
  })

  it('resolves nothing before the first get, keeping preload startup free', async () => {
    await loadPlatformApi()

    expect(mocks.getLinuxDisplayServer).not.toHaveBeenCalled()
  })
})
