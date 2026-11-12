import { describe, expect, it, vi } from 'vitest'

vi.mock('node:os', () => ({
  networkInterfaces: () => ({
    eth0: [
      { address: '192.168.1.20', family: 'IPv4', internal: false },
      { address: '2001:db8::20', family: 'IPv6', internal: false }
    ]
  })
}))

import { getDefaultPairingAddress, getPairingNetworkInterfaces } from './pairing-network-interfaces'

describe('IPv4-mapped pairing listeners', () => {
  it.each(['::ffff:0.0.0.0', '0:0:0:0:0:ffff:0:0'])(
    'advertises only a reachable IPv4 interface for %s',
    async (listenerHost) => {
      expect(await getPairingNetworkInterfaces(listenerHost)).toEqual([
        { name: 'eth0', address: '192.168.1.20' }
      ])
      expect(await getDefaultPairingAddress(listenerHost)).toBe('192.168.1.20')
    }
  )
})
