import { describe, expect, it, vi } from 'vitest'
import {
  getWindowsDefaultRouteInterfaceNames,
  type WindowsDefaultRouteEnvironment
} from './windows-default-route-interfaces'

function environment(
  runPowerShell: WindowsDefaultRouteEnvironment['runPowerShell'],
  platform: NodeJS.Platform = 'win32'
): WindowsDefaultRouteEnvironment {
  return { platform, systemRoot: 'C:\\Windows', runPowerShell }
}

describe('getWindowsDefaultRouteInterfaceNames', () => {
  it('returns unknown when route inspection fails or emits malformed data', async () => {
    await expect(
      getWindowsDefaultRouteInterfaceNames(
        environment(vi.fn().mockRejectedValue(new Error('managed host')))
      )
    ).resolves.toBeNull()
    await expect(
      getWindowsDefaultRouteInterfaceNames(environment(vi.fn().mockResolvedValue('"Ethernet"')))
    ).resolves.toBeNull()
  })

  it('does not inspect routes outside Windows', async () => {
    const runPowerShell = vi.fn()
    await expect(
      getWindowsDefaultRouteInterfaceNames(environment(runPowerShell, 'linux'))
    ).resolves.toEqual(new Set())
    expect(runPowerShell).not.toHaveBeenCalled()
  })
})
