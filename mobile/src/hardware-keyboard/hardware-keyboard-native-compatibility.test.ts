import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  nativeModule: {} as {
    isHardwareKeyboardConnected?: () => boolean
    setCommands?: (commands: unknown[]) => void
  }
}))

vi.mock('expo-modules-core', () => ({
  NativeModule: class {},
  requireOptionalNativeModule: () => mocks.nativeModule
}))

beforeEach(() => {
  delete mocks.nativeModule.isHardwareKeyboardConnected
  delete mocks.nativeModule.setCommands
})

describe('hardware keyboard native compatibility', () => {
  it('falls back when an installed native module predates keyboard detection', async () => {
    const { isHardwareKeyboardConnected } =
      await import('../../packages/expo-hardware-keyboard-navigation/src')

    expect(isHardwareKeyboardConnected()).toBe(false)
  })

  it('uses keyboard detection when the installed native module supports it', async () => {
    mocks.nativeModule.isHardwareKeyboardConnected = () => true
    const { isHardwareKeyboardConnected } =
      await import('../../packages/expo-hardware-keyboard-navigation/src')

    expect(isHardwareKeyboardConnected()).toBe(true)
  })

  it('ignores command registration when the installed native module predates it', async () => {
    const { setHardwareKeyboardCommands } =
      await import('../../packages/expo-hardware-keyboard-navigation/src')

    expect(() => setHardwareKeyboardCommands([])).not.toThrow()
  })
})
