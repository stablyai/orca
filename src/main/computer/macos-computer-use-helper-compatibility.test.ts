import { execFileSync } from 'node:child_process'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearMacOSComputerUseHelperCompatibilityCache,
  compareVersions,
  formatMacOSComputerUseHelperUnavailableReason,
  getMacOSComputerUseHelperCompatibility
} from './macos-computer-use-helper-compatibility'

vi.mock('node:child_process', () => ({ execFileSync: vi.fn() }))

describe('macOS Computer Use helper compatibility', () => {
  beforeEach(() => {
    vi.mocked(execFileSync).mockReset()
    clearMacOSComputerUseHelperCompatibilityCache()
  })

  it('compares dotted macOS versions numerically', () => {
    expect(compareVersions('13.6.9', '14.0')).toBeLessThan(0)
    expect(compareVersions('14.0', '14')).toBe(0)
    expect(compareVersions('14.10', '14.9')).toBeGreaterThan(0)
  })

  it('reports an installed helper whose minimum exceeds the current OS', () => {
    vi.mocked(execFileSync).mockImplementation((command) => {
      if (command === '/usr/bin/sw_vers') {
        return '13.6.9\n'
      }
      return '14.0\n'
    })

    const result = getMacOSComputerUseHelperCompatibility('/Applications/Orca Computer Use.app')

    expect(result).toEqual({
      compatible: false,
      currentVersion: '13.6.9',
      minimumVersion: '14.0'
    })
    expect(formatMacOSComputerUseHelperUnavailableReason(result!)).toBe(
      'Orca Computer Use requires macOS 14.0 or newer (this Mac is running macOS 13.6.9)'
    )
  })

  it('does not classify unreadable metadata as a known incompatibility', () => {
    vi.mocked(execFileSync).mockImplementation(() => {
      throw new Error('unreadable')
    })

    expect(getMacOSComputerUseHelperCompatibility('/Applications/Orca Computer Use.app')).toBeNull()
  })

  it('caches successful compatibility metadata for the immutable helper app', () => {
    vi.mocked(execFileSync).mockImplementation((command) => {
      return command === '/usr/bin/sw_vers' ? '12.7.6\n' : '12.0\n'
    })

    getMacOSComputerUseHelperCompatibility('/Applications/Orca Computer Use.app')
    getMacOSComputerUseHelperCompatibility('/Applications/Orca Computer Use.app')

    expect(execFileSync).toHaveBeenCalledTimes(2)
  })
})
