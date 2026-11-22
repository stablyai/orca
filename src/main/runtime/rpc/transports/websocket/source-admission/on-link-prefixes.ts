// Prefixes of this host's own interfaces: a peer inside one shares the server's network segment.
import { BlockList, isIP } from 'node:net'
import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os'
import { normalizeSourceAddress } from './network-source-class'

// Interfaces change rarely; re-reading at most this often keeps accept cheap.
const REFRESH_INTERVAL_MS = 5_000
// Wider "on-link" prefixes are misconfiguration, not a local segment.
const MIN_PREFIX = { ipv4: 16, ipv6: 48 } as const

export function onLinkPrefixList(
  interfaces: NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces()
): BlockList {
  const list = new BlockList()
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      const [address = '', bits] = entry.cidr?.split('/') ?? []
      const bare = address.split('%')[0]!
      const type = isIP(bare) === 6 ? 'ipv6' : isIP(bare) === 4 ? 'ipv4' : null
      const prefix = Number(bits)
      if (entry.internal || type === null || !Number.isInteger(prefix)) {
        continue
      }
      if (prefix >= MIN_PREFIX[type]) {
        list.addSubnet(bare, prefix, type)
      }
    }
  }
  return list
}

export class OnLinkPrefixes {
  private list: BlockList | null = null
  private readAt = Number.NEGATIVE_INFINITY

  constructor(
    private readonly read: () => BlockList = onLinkPrefixList,
    private readonly now: () => number = Date.now
  ) {}

  contains(rawAddress: string | undefined): boolean {
    const address = normalizeSourceAddress(rawAddress)
    if (address === null) {
      return false
    }
    const now = this.now()
    if (this.list === null || now - this.readAt >= REFRESH_INTERVAL_MS) {
      try {
        this.list = this.read()
      } catch {
        // networkInterfaces can throw on some platforms; treat as no on-link prefixes.
        this.list = new BlockList()
      }
      this.readAt = now
    }
    return this.list.check(address, isIP(address) === 6 ? 'ipv6' : 'ipv4')
  }
}
