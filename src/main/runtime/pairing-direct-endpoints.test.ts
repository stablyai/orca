import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { networkInterfaces } from 'node:os'
import type { PairingGetDirectEndpointsResult } from '../../shared/pairing-direct-endpoints'
import { getPairingNetworkInterfaces } from './pairing-network-interfaces'

vi.mock('./pairing-network-interfaces', () => ({ getPairingNetworkInterfaces: vi.fn() }))
vi.mock('node:os', () => ({ networkInterfaces: vi.fn() }))

let resolvePairingDirectEndpoints: (
  boundEndpoint: string | null
) => Promise<PairingGetDirectEndpointsResult>

describe('advertising reachable direct listeners', () => {
  beforeEach(async () => {
    vi.resetAllMocks()
    vi.resetModules()
    vi.useFakeTimers()
    vi.mocked(networkInterfaces).mockReturnValue({})
    ;({ resolvePairingDirectEndpoints } = await import('./pairing-direct-endpoints'))
  })
  afterEach(() => vi.useRealTimers())

  it('filters host-local adapters and non-unicast addresses while retaining an external Hyper-V switch', async () => {
    vi.mocked(getPairingNetworkInterfaces).mockResolvedValue([
      { name: 'docker0', address: '172.17.0.1' },
      { name: 'vEthernet (WSL)', address: '172.25.0.1', hasDefaultRoute: true },
      { name: 'vEthernet (External)', address: '192.168.1.20', hasDefaultRoute: true },
      { name: 'vEthernet (Unknown)', address: '192.168.2.20' },
      { name: 'tun0', address: '198.18.0.1' },
      { name: 'en0', address: '169.254.1.2' },
      { name: 'en0', address: '224.0.0.1' },
      { name: 'en0', address: '255.255.255.255' },
      { name: 'en0', address: '0.1.2.3' },
      { name: 'lo0', address: '127.0.0.2' },
      { name: 'tailscale0', address: '100.64.0.2' }
    ])
    await expect(resolvePairingDirectEndpoints('ws://0.0.0.0:6769')).resolves.toEqual({
      v: 1,
      endpoints: [
        { kind: 'lan', url: 'ws://192.168.1.20:6769' },
        { kind: 'tailscale', url: 'ws://100.64.0.2:6769' }
      ]
    })
  })

  it('only advertises addresses served by a specific interface or IPv4 listener', async () => {
    vi.mocked(getPairingNetworkInterfaces).mockResolvedValue([
      { name: 'en0', address: '10.20.30.40' },
      { name: 'en1', address: '192.168.1.20' },
      { name: 'en0', address: 'fd00::1234' }
    ])
    await expect(resolvePairingDirectEndpoints('ws://10.20.30.40:6768')).resolves.toEqual({
      v: 1,
      endpoints: [{ kind: 'lan', url: 'ws://10.20.30.40:6768' }]
    })
    const ipv4 = await resolvePairingDirectEndpoints('ws://0.0.0.0:6768')
    expect(ipv4.endpoints.map(({ url }) => url)).toEqual([
      'ws://10.20.30.40:6768',
      'ws://192.168.1.20:6768'
    ])
  })

  it('formats usable IPv6 addresses without advertising link-local, mapped or multicast addresses', async () => {
    vi.mocked(getPairingNetworkInterfaces).mockResolvedValue([
      { name: 'en0', address: 'fd00::1234' },
      { name: 'en0', address: 'fe80::1234' },
      { name: 'en0', address: 'ff02::1' },
      { name: 'en0', address: '::ffff:169.254.1.2' },
      { name: 'lo0', address: '::1' }
    ])
    await expect(resolvePairingDirectEndpoints('ws://[::]:6768')).resolves.toEqual({
      v: 1,
      endpoints: [{ kind: 'lan', url: 'ws://[fd00::1234]:6768' }]
    })
  })

  it('bounds parallel phone probes and deduplicates interface aliases', async () => {
    vi.mocked(getPairingNetworkInterfaces).mockResolvedValue([
      { name: 'en0', address: '10.0.0.1' },
      ...Array.from({ length: 12 }, (_, index) => ({ name: 'en0', address: `10.0.0.${index + 1}` }))
    ])
    const result = await resolvePairingDirectEndpoints('ws://0.0.0.0:6768')
    expect(result.endpoints).toHaveLength(8)
    expect(new Set(result.endpoints.map(({ url }) => url)).size).toBe(8)
  })

  it('does not enumerate interfaces when there is no listener', async () => {
    await expect(resolvePairingDirectEndpoints(null)).resolves.toEqual({ v: 1, endpoints: [] })
    expect(getPairingNetworkInterfaces).not.toHaveBeenCalled()
  })

  it('shares route inspection across concurrent phones and repeated 15-second probes', async () => {
    vi.mocked(networkInterfaces).mockReturnValue({
      'vEthernet (WSL)': [
        {
          address: '172.25.0.1',
          netmask: '255.255.0.0',
          family: 'IPv4',
          mac: '00:00:00:00:00:00',
          internal: false,
          cidr: '172.25.0.1/16'
        }
      ]
    })
    let finish: (
      interfaces: Awaited<ReturnType<typeof getPairingNetworkInterfaces>>
    ) => void = () => {}
    vi.mocked(getPairingNetworkInterfaces).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    const first = resolvePairingDirectEndpoints('ws://0.0.0.0:6768')
    const second = resolvePairingDirectEndpoints('ws://0.0.0.0:6769')
    expect(getPairingNetworkInterfaces).toHaveBeenCalledOnce()
    finish([{ name: 'en0', address: '192.168.1.20' }])
    expect((await first).endpoints[0]?.url).toBe('ws://192.168.1.20:6768')
    expect((await second).endpoints[0]?.url).toBe('ws://192.168.1.20:6769')
    for (let poll = 0; poll < 3; poll++) {
      vi.advanceTimersByTime(15_000)
      await resolvePairingDirectEndpoints('ws://0.0.0.0:6768')
    }
    expect(getPairingNetworkInterfaces).toHaveBeenCalledOnce()
    vi.mocked(getPairingNetworkInterfaces).mockResolvedValue([])
    vi.advanceTimersByTime(15_000)
    expect((await resolvePairingDirectEndpoints('ws://0.0.0.0:6768')).endpoints).toEqual([])
    expect(getPairingNetworkInterfaces).toHaveBeenCalledTimes(2)
  })

  it('refreshes on an address change before the TTL and ignores an older in-flight result', async () => {
    vi.mocked(networkInterfaces).mockReturnValue({
      'vEthernet (WSL)': [
        {
          address: '172.25.0.1',
          netmask: '255.255.0.0',
          family: 'IPv4',
          mac: '00:00:00:00:00:00',
          internal: false,
          cidr: '172.25.0.1/16'
        }
      ]
    })
    let finish: (
      interfaces: Awaited<ReturnType<typeof getPairingNetworkInterfaces>>
    ) => void = () => {}
    vi.mocked(getPairingNetworkInterfaces).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    const oldRequest = resolvePairingDirectEndpoints('ws://0.0.0.0:6768')
    vi.mocked(networkInterfaces).mockReturnValue({
      'vEthernet (WSL)': [
        {
          address: '172.25.0.2',
          netmask: '255.255.0.0',
          family: 'IPv4',
          mac: '00:00:00:00:00:00',
          internal: false,
          cidr: '172.25.0.2/16'
        }
      ],
      en0: [
        {
          address: '10.20.30.40',
          netmask: '255.255.255.0',
          family: 'IPv4',
          mac: '00:00:00:00:00:00',
          internal: false,
          cidr: '10.20.30.40/24'
        }
      ]
    })
    vi.mocked(getPairingNetworkInterfaces).mockResolvedValue([
      { name: 'en0', address: '10.20.30.40' }
    ])
    expect((await resolvePairingDirectEndpoints('ws://0.0.0.0:6768')).endpoints[0]?.url).toBe(
      'ws://10.20.30.40:6768'
    )
    finish([{ name: 'en0', address: '192.168.1.20' }])
    await oldRequest
    expect((await resolvePairingDirectEndpoints('ws://0.0.0.0:6768')).endpoints[0]?.url).toBe(
      'ws://10.20.30.40:6768'
    )
    expect(getPairingNetworkInterfaces).toHaveBeenCalledTimes(2)
  })

  it('bounds retries when Windows route inspection returns no reachable adapters', async () => {
    vi.mocked(networkInterfaces).mockReturnValue({
      'vEthernet (WSL)': [
        {
          address: '172.25.0.1',
          netmask: '255.255.0.0',
          family: 'IPv4',
          mac: '00:00:00:00:00:00',
          internal: false,
          cidr: '172.25.0.1/16'
        }
      ]
    })
    vi.mocked(getPairingNetworkInterfaces).mockResolvedValue([
      { name: 'vEthernet (Unknown)', address: '192.168.1.20' }
    ])
    expect((await resolvePairingDirectEndpoints('ws://0.0.0.0:6768')).endpoints).toEqual([])
    vi.advanceTimersByTime(15_000)
    expect((await resolvePairingDirectEndpoints('ws://0.0.0.0:6768')).endpoints).toEqual([])
    expect(getPairingNetworkInterfaces).toHaveBeenCalledOnce()
  })
})
