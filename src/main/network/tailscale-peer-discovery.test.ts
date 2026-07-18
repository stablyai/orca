import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  __resetTailnetPeerDiscoveryForTests,
  discoverTailnetPeers,
  parseTailscaleStatusPeers
} from './tailscale-peer-discovery'

function statusJson(peers: Record<string, unknown>): string {
  return JSON.stringify({
    Version: '1.86.0',
    BackendState: 'Running',
    Self: { HostName: 'my-laptop', DNSName: 'my-laptop.tail1234.ts.net.' },
    MagicDNSSuffix: 'tail1234.ts.net',
    Peer: peers
  })
}

describe('parseTailscaleStatusPeers', () => {
  it('maps peers to suggestions with trimmed MagicDNS names and tailnet IPv4', () => {
    const peers = parseTailscaleStatusPeers(
      statusJson({
        'nodekey:aa': {
          HostName: 'sezerchicago',
          DNSName: 'sezerchicago.tail1234.ts.net.',
          OS: 'linux',
          TailscaleIPs: ['fd7a:115c:a1e0::1', '100.96.7.56'],
          Online: true,
          sshHostKeys: ['ssh-ed25519 AAAA...']
        }
      })
    )

    expect(peers).toEqual([
      {
        hostName: 'sezerchicago',
        dnsName: 'sezerchicago.tail1234.ts.net',
        ipv4: '100.96.7.56',
        os: 'linux',
        online: true,
        tailscaleSsh: true
      }
    ])
  })

  it('sorts online peers first, then by host name', () => {
    const peers = parseTailscaleStatusPeers(
      statusJson({
        'nodekey:aa': { HostName: 'zeta', DNSName: 'zeta.ts.net.', Online: true },
        'nodekey:bb': { HostName: 'alpha', DNSName: 'alpha.ts.net.', Online: false },
        'nodekey:cc': { HostName: 'beta', DNSName: 'beta.ts.net.', Online: true }
      })
    )

    expect(peers.map((peer) => peer.hostName)).toEqual(['beta', 'zeta', 'alpha'])
    expect(peers.map((peer) => peer.online)).toEqual([true, true, false])
  })

  it('filters Mullvad exit nodes and entries with no usable address', () => {
    const peers = parseTailscaleStatusPeers(
      statusJson({
        'nodekey:aa': {
          HostName: 'de-ber-wg-001',
          DNSName: 'de-ber-wg-001.mullvad.ts.net.',
          TailscaleIPs: ['100.127.0.1'],
          Online: true
        },
        'nodekey:bb': { HostName: 'no-address', TailscaleIPs: ['192.168.1.5'], Online: true },
        'nodekey:cc': 'not-an-object',
        'nodekey:dd': { HostName: 'kept', DNSName: 'kept.tail1234.ts.net.', Online: true }
      })
    )

    expect(peers.map((peer) => peer.hostName)).toEqual(['kept'])
  })

  it('falls back to the MagicDNS label, then the IPv4, when HostName is missing', () => {
    const peers = parseTailscaleStatusPeers(
      statusJson({
        'nodekey:aa': { DNSName: 'named-by-dns.tail1234.ts.net.', Online: true },
        'nodekey:bb': { TailscaleIPs: ['100.64.0.9'], Online: false }
      })
    )

    expect(peers.map((peer) => peer.hostName)).toEqual(['named-by-dns', '100.64.0.9'])
  })

  it('returns an empty list for malformed or peer-less status output', () => {
    expect(parseTailscaleStatusPeers('not json')).toEqual([])
    expect(parseTailscaleStatusPeers('{}')).toEqual([])
    expect(parseTailscaleStatusPeers(JSON.stringify({ Peer: null }))).toEqual([])
  })
})

describe('discoverTailnetPeers', () => {
  beforeEach(() => {
    __resetTailnetPeerDiscoveryForTests()
  })

  it('reports available with parsed peers when the CLI responds', async () => {
    const runStatus = vi
      .fn()
      .mockResolvedValue(
        statusJson({
          'nodekey:aa': { HostName: 'peer-a', DNSName: 'peer-a.ts.net.', Online: true }
        })
      )

    const discovery = await discoverTailnetPeers(runStatus)

    expect(discovery.available).toBe(true)
    expect(discovery.peers.map((peer) => peer.hostName)).toEqual(['peer-a'])
  })

  it('reports unavailable without throwing when the CLI is missing', async () => {
    const runStatus = vi.fn().mockRejectedValue(new Error('spawn tailscale ENOENT'))

    await expect(discoverTailnetPeers(runStatus)).resolves.toEqual({
      available: false,
      peers: []
    })
  })

  it('serves cached results inside the TTL instead of re-running the CLI', async () => {
    const runStatus = vi.fn().mockResolvedValue(statusJson({}))

    await discoverTailnetPeers(runStatus)
    await discoverTailnetPeers(runStatus)

    expect(runStatus).toHaveBeenCalledTimes(1)
  })
})
