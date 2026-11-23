import type * as NodeOs from 'node:os'
import type { NetworkInterfaceInfo } from 'node:os'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { networkInterfacesMock } = vi.hoisted(() => ({
  networkInterfacesMock: vi.fn<() => NodeJS.Dict<NetworkInterfaceInfo[]>>()
}))

vi.mock('node:os', async (importOriginal) => ({
  ...(await importOriginal<typeof NodeOs>()),
  networkInterfaces: networkInterfacesMock
}))

import { isAutoAdvertisablePairingInterface } from '../../../../../../shared/remote-runtime/pairing/pairing-address-auto-selection'
import { getDefaultPairingAddress } from './pairing-network-interfaces'

function ipv4(address: string): NetworkInterfaceInfo {
  return {
    address,
    family: 'IPv4',
    internal: false,
    netmask: '255.255.0.0',
    mac: '00:00:00:00:00:00',
    cidr: null
  }
}

const noDefaultRoute = async (): Promise<ReadonlySet<string>> => new Set()

describe('getPairingNetworkInterfaces', () => {
  beforeEach(() => {
    networkInterfacesMock.mockReset()
  })

  it('advertises WLAN over a full-tunnel TUN adapter that holds the default route', async () => {
    networkInterfacesMock.mockReturnValue({
      singbox_tun: [ipv4('172.18.0.1')],
      WLAN: [ipv4('192.168.1.20')]
    })

    await expect(
      getDefaultPairingAddress('0.0.0.0', async () => new Set(['singbox_tun']))
    ).resolves.toBe('192.168.1.20')
  })

  it('offers no direct address when only a tunnel adapter remains', async () => {
    networkInterfacesMock.mockReturnValue({
      singbox_tun: [ipv4('172.18.0.1')]
    })

    await expect(getDefaultPairingAddress('0.0.0.0', noDefaultRoute)).resolves.toBeNull()
  })

  it('keeps the tailnet address and drops the tunnel adapter', async () => {
    networkInterfacesMock.mockReturnValue({
      Tailscale: [ipv4('100.101.102.103')],
      'WireGuard Tunnel': [ipv4('10.8.0.2')]
    })

    expect(
      isAutoAdvertisablePairingInterface({ name: 'Tailscale', address: '100.101.102.103' })
    ).toBe(true)
    expect(
      isAutoAdvertisablePairingInterface({ name: 'WireGuard Tunnel', address: '10.8.0.2' })
    ).toBe(false)
    await expect(getDefaultPairingAddress('0.0.0.0', noDefaultRoute)).resolves.toBe(
      '100.101.102.103'
    )
  })
})
