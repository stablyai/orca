import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { loadNative, record } = vi.hoisted(() => ({ loadNative: vi.fn(), record: vi.fn() }))
vi.mock('node:module', () => ({ createRequire: () => loadNative }))
vi.mock('../updater-lifecycle-diagnostics', () => ({ recordUpdaterLifecycle: record }))

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!
const originalResources = Object.getOwnPropertyDescriptor(process, 'resourcesPath')

beforeEach(() => {
  vi.resetModules()
  loadNative.mockReset()
  record.mockReset()
  Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
  Object.defineProperty(process, 'resourcesPath', { value: '/orca-resources', configurable: true })
})

afterEach(() => {
  Object.defineProperty(process, 'platform', originalPlatform)
  if (originalResources) {
    Object.defineProperty(process, 'resourcesPath', originalResources)
  } else {
    Reflect.deleteProperty(process, 'resourcesPath')
  }
})

describe('macOS installer scheduling', () => {
  it('configures once before native staging and records the resource class', async () => {
    const configure = vi.fn(() => true)
    loadNative.mockReturnValue({ configure })
    const { configureMacShipItScheduling } = await import('./macos-shipit-scheduling')
    configureMacShipItScheduling()
    configureMacShipItScheduling()
    expect(configure).toHaveBeenCalledTimes(1)
    expect(record).toHaveBeenCalledWith('macos_installer_scheduling_configured', {
      processType: 'Interactive'
    })
  })

  it.each([
    { addon: null, reason: 'missing_export' },
    { addon: {}, reason: 'missing_export' },
    { addon: { configure: () => false }, reason: 'contract_mismatch' },
    {
      addon: {
        configure: () => {
          throw new Error('unsupported')
        }
      },
      reason: 'configure_failed'
    }
  ])(
    'keeps the updater usable and retries when the native hook is unavailable: %j',
    async ({ addon, reason }) => {
      loadNative.mockReturnValueOnce(addon).mockReturnValue({ configure: () => true })
      const { configureMacShipItScheduling } = await import('./macos-shipit-scheduling')
      expect(() => configureMacShipItScheduling()).not.toThrow()
      configureMacShipItScheduling()
      expect(loadNative).toHaveBeenCalledTimes(2)
      expect(record).toHaveBeenCalledWith(
        'macos_installer_scheduling_unavailable',
        expect.objectContaining({ reason }),
        expect.objectContaining({ level: 'warn' })
      )
    }
  )

  it('records a native load failure and retries the same module on the next attempt', async () => {
    loadNative
      .mockImplementationOnce(() => {
        throw new Error('missing addon')
      })
      .mockReturnValue({ configure: () => true })
    const { configureMacShipItScheduling } = await import('./macos-shipit-scheduling')
    expect(() => configureMacShipItScheduling()).not.toThrow()
    expect(record).toHaveBeenCalledWith(
      'macos_installer_scheduling_unavailable',
      { reason: 'load_failed', errorType: 'Error' },
      expect.objectContaining({ level: 'warn' })
    )
    configureMacShipItScheduling()
    expect(record).toHaveBeenCalledWith('macos_installer_scheduling_configured', {
      processType: 'Interactive'
    })
  })

  it('does not load native code on other platforms', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    const { configureMacShipItScheduling } = await import('./macos-shipit-scheduling')
    configureMacShipItScheduling()
    expect(loadNative).not.toHaveBeenCalled()
  })
})
