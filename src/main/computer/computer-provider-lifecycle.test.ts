import { describe, expect, it, vi } from 'vitest'
import { ComputerProviderLifecycle } from './computer-provider-lifecycle'

function provider(name: string) {
  return {
    name,
    capabilities: vi.fn(),
    listApps: vi.fn(),
    listWindows: vi.fn(),
    snapshot: vi.fn(),
    action: vi.fn(),
    shutdown: vi.fn()
  }
}

describe('ComputerProviderLifecycle', () => {
  it('rechecks macOS provider availability after an initial miss', () => {
    const macProvider = provider('mac')
    const shouldUseMacOSNativeProvider = vi.fn().mockReturnValueOnce(false).mockReturnValue(true)
    const lifecycle = new ComputerProviderLifecycle({
      shouldUseMacOSNativeProvider,
      createMacOSNativeProvider: vi.fn(() => macProvider as never),
      shouldUseDesktopScriptProvider: vi.fn(() => false),
      createDesktopScriptProvider: vi.fn()
    })

    expect(lifecycle.current('darwin')).toBeNull()
    expect(lifecycle.current('darwin')).toBe(macProvider)
    expect(shouldUseMacOSNativeProvider).toHaveBeenCalledTimes(2)
  })

  it('caches an available provider and shuts it down', () => {
    const macProvider = provider('mac')
    const createMacOSNativeProvider = vi.fn(() => macProvider as never)
    const lifecycle = new ComputerProviderLifecycle({
      shouldUseMacOSNativeProvider: vi.fn(() => true),
      createMacOSNativeProvider,
      shouldUseDesktopScriptProvider: vi.fn(() => false),
      createDesktopScriptProvider: vi.fn()
    })

    expect(lifecycle.current('darwin')).toBe(macProvider)
    expect(lifecycle.current('darwin')).toBe(macProvider)
    expect(createMacOSNativeProvider).toHaveBeenCalledTimes(1)

    lifecycle.shutdown()

    expect(macProvider.shutdown).toHaveBeenCalledTimes(1)
  })

  it('uses the desktop script provider on Linux when available', () => {
    const desktopProvider = provider('desktop')
    const lifecycle = new ComputerProviderLifecycle({
      shouldUseMacOSNativeProvider: vi.fn(() => false),
      createMacOSNativeProvider: vi.fn(),
      shouldUseDesktopScriptProvider: vi.fn(() => true),
      createDesktopScriptProvider: vi.fn(() => desktopProvider as never)
    })

    expect(lifecycle.current('linux')).toBe(desktopProvider)
  })

  it('shuts down the desktop script provider', () => {
    const desktopProvider = provider('desktop')
    const lifecycle = new ComputerProviderLifecycle({
      shouldUseMacOSNativeProvider: vi.fn(() => false),
      createMacOSNativeProvider: vi.fn(),
      shouldUseDesktopScriptProvider: vi.fn(() => true),
      createDesktopScriptProvider: vi.fn(() => desktopProvider as never)
    })

    expect(lifecycle.current('linux')).toBe(desktopProvider)

    lifecycle.shutdown()

    expect(desktopProvider.shutdown).toHaveBeenCalledTimes(1)
  })
})
