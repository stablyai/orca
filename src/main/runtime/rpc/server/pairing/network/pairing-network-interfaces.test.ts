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

import { getDefaultPairingAddress, getPairingNetworkInterfaces } from './pairing-network-interfaces'

function ipv4(address: string, internal = false): NetworkInterfaceInfo {
  return {
    address,
    family: 'IPv4',
    internal,
    netmask: '255.255.0.0',
    mac: '00:00:00:00:00:00',
    cidr: null
  }
}

function ipv6(address: string): NetworkInterfaceInfo {
  return {
    address,
    family: 'IPv6',
    internal: false,
    netmask: 'ffff:ffff:ffff:ffff::',
    mac: '00:00:00:00:00:00',
    cidr: null,
    scopeid: 0
  }
}

const noDefaultRoute = async (): Promise<ReadonlySet<string>> => new Set()

describe('getPairingNetworkInterfaces', () => {
  beforeEach(() => {
    networkInterfacesMock.mockReset()
  })

  it('never offers link-local or loopback addresses', async () => {
    networkInterfacesMock.mockReturnValue({
      'Ethernet 2': [ipv4('169.254.83.107'), ipv6('fe80::1234')],
      Loopback: [ipv4('127.0.0.1', true)],
      'Wi-Fi': [ipv4('192.168.1.20')]
    })

    const interfaces = await getPairingNetworkInterfaces('::', noDefaultRoute)

    expect(interfaces.map((iface) => iface.address)).toEqual(['192.168.1.20'])
  })

  it('offers no direct address when only link-local adapters exist', async () => {
    networkInterfacesMock.mockReturnValue({
      'Ethernet 2': [ipv4('169.254.83.107'), ipv6('fe80::1234')]
    })

    await expect(getDefaultPairingAddress('0.0.0.0', noDefaultRoute)).resolves.toBeNull()
  })

  it('still ranks Tailscale first, then prefers the default-route adapter', async () => {
    networkInterfacesMock.mockReturnValue({
      'Ethernet 3': [ipv4('10.8.0.2')],
      'vEthernet (WSL (Hyper-V firewall))': [ipv4('172.20.96.1')],
      'Wi-Fi': [ipv4('192.168.1.20')],
      Tailscale: [ipv4('100.101.102.103')]
    })
    const defaultRoute = async (): Promise<ReadonlySet<string>> => new Set(['Wi-Fi'])

    const interfaces = await getPairingNetworkInterfaces('0.0.0.0', defaultRoute)

    expect(interfaces.map((iface) => iface.address)).toEqual([
      '100.101.102.103',
      '192.168.1.20',
      '10.8.0.2',
      '172.20.96.1'
    ])
    await expect(getDefaultPairingAddress('0.0.0.0', defaultRoute)).resolves.toBe('100.101.102.103')
  })

  it('advertises the default-route LAN over an idle adapter listed first', async () => {
    networkInterfacesMock.mockReturnValue({
      'Ethernet 3': [ipv4('10.8.0.2')],
      'vEthernet (Default Switch)': [ipv4('172.28.80.1')],
      'Wi-Fi': [ipv4('192.168.1.20')]
    })

    await expect(getDefaultPairingAddress('0.0.0.0', async () => new Set(['wi-fi']))).resolves.toBe(
      '192.168.1.20'
    )
  })
})
