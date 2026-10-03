import { beforeEach, expect, it, vi } from 'vitest'

const requireOptionalNativeModule = vi.hoisted(() => vi.fn())
vi.mock('expo-modules-core', () => ({ requireOptionalNativeModule }))

beforeEach(() => {
  vi.resetModules()
  requireOptionalNativeModule.mockReset()
})

it('binds the native module by the name the Swift and Kotlin modules register', async () => {
  const module = { supportsAlternateIcons: vi.fn() }
  requireOptionalNativeModule.mockReturnValue(module)
  expect((await import('./native-app-icon')).nativeAppIcon).toBe(module)
  expect(requireOptionalNativeModule).toHaveBeenCalledWith('OrcaAppIcon')
})

it('reports no switcher when an older binary lacks the module', async () => {
  requireOptionalNativeModule.mockReturnValue(null)
  expect((await import('./native-app-icon')).nativeAppIcon).toBeNull()
})

it('does not load a native module in the web shell', async () => {
  expect((await import('./native-app-icon.web')).nativeAppIcon).toBeNull()
  expect(requireOptionalNativeModule).not.toHaveBeenCalled()
})
