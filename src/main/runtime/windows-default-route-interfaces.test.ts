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
  it('returns active IPv4 and IPv6 default-route interface aliases', async () => {
    const runPowerShell = vi.fn().mockResolvedValue('["vEthernet (Production LAN)","Ethernet"]')

    await expect(getWindowsDefaultRouteInterfaceNames(environment(runPowerShell))).resolves.toEqual(
      new Set(['vEthernet (Production LAN)', 'Ethernet'])
    )

    const script = runPowerShell.mock.calls[0]![0] as string
    expect(runPowerShell.mock.calls[0]![1]).toBe(3_000)
    expect(script).toContain("$ProgressPreference = 'SilentlyContinue'")
    expect(script).toContain("$_.State -eq 'Alive'")
    expect(script).toContain("$_.DestinationPrefix -eq '0.0.0.0/0'")
    expect(script).toContain("$_.DestinationPrefix -eq '::/0'")
  })

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
