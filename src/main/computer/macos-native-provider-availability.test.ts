import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

const resolveAppPathMock = vi.hoisted(() => vi.fn())
const resolveExecutablePathMock = vi.hoisted(() => vi.fn())
const getCompatibilityMock = vi.hoisted(() => vi.fn())

vi.mock('./macos-native-provider-paths', () => ({
  resolveMacOSComputerUseAppPath: resolveAppPathMock,
  resolveMacOSComputerUseExecutablePath: resolveExecutablePathMock
}))

vi.mock('./macos-computer-use-helper-compatibility', () => ({
  getMacOSComputerUseHelperCompatibility: getCompatibilityMock
}))

import { shouldUseMacOSNativeProvider } from './macos-native-provider-availability'

describe('macOS native provider availability', () => {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!

  beforeEach(() => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'darwin' })
    resolveAppPathMock.mockReset().mockReturnValue('/Applications/Orca Computer Use.app')
    resolveExecutablePathMock
      .mockReset()
      .mockReturnValue('/Applications/Orca Computer Use.app/Contents/MacOS/orca-computer-use-macos')
    getCompatibilityMock.mockReset()
  })

  afterAll(() => {
    Object.defineProperty(process, 'platform', originalPlatform)
  })

  it('selects a helper compatible with the current macOS version', () => {
    getCompatibilityMock.mockReturnValue({
      compatible: true,
      currentVersion: '12.0',
      minimumVersion: '12.0'
    })

    expect(shouldUseMacOSNativeProvider()).toBe(true)
  })

  it('rejects a helper whose minimum exceeds the current macOS version', () => {
    getCompatibilityMock.mockReturnValue({
      compatible: false,
      currentVersion: '13.6.9',
      minimumVersion: '14.0'
    })

    expect(shouldUseMacOSNativeProvider()).toBe(false)
  })
})
