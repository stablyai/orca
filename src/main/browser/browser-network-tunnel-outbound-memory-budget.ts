export const BROWSER_NETWORK_TUNNEL_HOST_MAX_OUTBOUND_BYTES = 32 * 1024 * 1024
export const BROWSER_NETWORK_TUNNEL_PROCESS_MAX_OUTBOUND_BYTES = 128 * 1024 * 1024

const DEFAULT_HOST_MAX_CLAIMS = 16_384
const DEFAULT_PROCESS_MAX_CLAIMS = 65_536
const DEFAULT_HOST_MAX_SOCKET_SOURCES = 8
const DEFAULT_PROCESS_MAX_SOCKET_SOURCES = 32
const DEFAULT_HOST_MAX_LEASES = 8
const DEFAULT_PROCESS_MAX_LEASES = 64
const DEFAULT_PROCESS_MAX_HOSTS = 32

export type BrowserNetworkTunnelOutboundSocketMemory = {
  canSend: (bytes: number, alreadyRetained?: boolean) => boolean
  release: () => void
}

export type BrowserNetworkTunnelOutboundMemoryLease = {
  claimApplicationBytes: (bytes: number) => (() => void) | null
  claimQueuedBytes: (bytes: number) => (() => void) | null
  registerBufferedAmount: (
    readBufferedAmount: () => number
  ) => BrowserNetworkTunnelOutboundSocketMemory | null
  release: () => void
}

type BrowserHostMemoryState = {
  leases: number
  retainedBytes: number
  claims: number
  bufferedSources: Set<() => number>
}

type BrowserNetworkTunnelOutboundMemoryBudgetOptions = {
  hostMaxBytes?: number
  processMaxBytes?: number
  hostMaxClaims?: number
  processMaxClaims?: number
  hostMaxSocketSources?: number
  processMaxSocketSources?: number
  hostMaxLeases?: number
  processMaxLeases?: number
  processMaxHosts?: number
}

export class BrowserNetworkTunnelOutboundMemoryBudgetRegistry {
  private readonly hostMaxBytes: number
  private readonly processMaxBytes: number
  private readonly hostMaxClaims: number
  private readonly processMaxClaims: number
  private readonly hostMaxSocketSources: number
  private readonly processMaxSocketSources: number
  private readonly hostMaxLeases: number
  private readonly processMaxLeases: number
  private readonly processMaxHosts: number
  private readonly hosts = new Map<string, BrowserHostMemoryState>()
  private readonly bufferedSources = new Set<() => number>()
  private retainedBytes = 0
  private claims = 0
  private leases = 0

  constructor(options: BrowserNetworkTunnelOutboundMemoryBudgetOptions = {}) {
    this.hostMaxBytes = options.hostMaxBytes ?? BROWSER_NETWORK_TUNNEL_HOST_MAX_OUTBOUND_BYTES
    this.processMaxBytes =
      options.processMaxBytes ?? BROWSER_NETWORK_TUNNEL_PROCESS_MAX_OUTBOUND_BYTES
    this.hostMaxClaims = options.hostMaxClaims ?? DEFAULT_HOST_MAX_CLAIMS
    this.processMaxClaims = options.processMaxClaims ?? DEFAULT_PROCESS_MAX_CLAIMS
    this.hostMaxSocketSources = options.hostMaxSocketSources ?? DEFAULT_HOST_MAX_SOCKET_SOURCES
    this.processMaxSocketSources =
      options.processMaxSocketSources ?? DEFAULT_PROCESS_MAX_SOCKET_SOURCES
    this.hostMaxLeases = options.hostMaxLeases ?? DEFAULT_HOST_MAX_LEASES
    this.processMaxLeases = options.processMaxLeases ?? DEFAULT_PROCESS_MAX_LEASES
    this.processMaxHosts = options.processMaxHosts ?? DEFAULT_PROCESS_MAX_HOSTS
  }

  acquire(browserHostClientId: string): BrowserNetworkTunnelOutboundMemoryLease | null {
    if (
      !browserHostClientId ||
      browserHostClientId.length > 256 ||
      this.leases >= this.processMaxLeases
    ) {
      return null
    }
    let host = this.hosts.get(browserHostClientId)
    if (!host) {
      if (this.hosts.size >= this.processMaxHosts) {
        return null
      }
      host = { leases: 0, retainedBytes: 0, claims: 0, bufferedSources: new Set() }
      this.hosts.set(browserHostClientId, host)
    }
    if (host.leases >= this.hostMaxLeases) {
      this.deleteEmptyHost(browserHostClientId, host)
      return null
    }
    host.leases += 1
    this.leases += 1
    return this.createLease(browserHostClientId, host)
  }

  evidence(): {
    hosts: number
    leases: number
    retainedBytes: number
    bufferedBytes: number
    claims: number
    socketSources: number
  } {
    return {
      hosts: this.hosts.size,
      leases: this.leases,
      retainedBytes: this.retainedBytes,
      bufferedBytes: readBufferedBytes(this.bufferedSources),
      claims: this.claims,
      socketSources: this.bufferedSources.size
    }
  }

  private createLease(
    browserHostClientId: string,
    host: BrowserHostMemoryState
  ): BrowserNetworkTunnelOutboundMemoryLease {
    let active = true
    const claim = (bytes: number): (() => void) | null => {
      if (!active || !this.canClaim(host, bytes)) {
        return null
      }
      host.retainedBytes += bytes
      host.claims += 1
      this.retainedBytes += bytes
      this.claims += 1
      return createRelease(() => {
        host.retainedBytes -= bytes
        host.claims -= 1
        this.retainedBytes -= bytes
        this.claims -= 1
        this.deleteEmptyHost(browserHostClientId, host)
      })
    }
    return {
      claimApplicationBytes: claim,
      claimQueuedBytes: claim,
      registerBufferedAmount: (readBufferedAmount) => {
        if (
          !active ||
          host.bufferedSources.size >= this.hostMaxSocketSources ||
          this.bufferedSources.size >= this.processMaxSocketSources
        ) {
          return null
        }
        const source = (): number => readBufferedAmount()
        host.bufferedSources.add(source)
        this.bufferedSources.add(source)
        let registered = true
        return {
          canSend: (bytes, alreadyRetained = false) =>
            registered && active && this.canFitBytes(host, bytes, alreadyRetained ? 0 : bytes),
          release: createRelease(() => {
            registered = false
            host.bufferedSources.delete(source)
            this.bufferedSources.delete(source)
            this.deleteEmptyHost(browserHostClientId, host)
          })
        }
      },
      release: createRelease(() => {
        active = false
        host.leases -= 1
        this.leases -= 1
        this.deleteEmptyHost(browserHostClientId, host)
      })
    }
  }

  private canClaim(host: BrowserHostMemoryState, bytes: number): boolean {
    return (
      host.claims < this.hostMaxClaims &&
      this.claims < this.processMaxClaims &&
      this.canFitBytes(host, bytes, bytes)
    )
  }

  private canFitBytes(host: BrowserHostMemoryState, bytes: number, addedBytes: number): boolean {
    if (!Number.isSafeInteger(bytes) || bytes < 0) {
      return false
    }
    const hostBufferedBytes = readBufferedBytes(host.bufferedSources)
    const processBufferedBytes = readBufferedBytes(this.bufferedSources)
    return (
      host.retainedBytes + hostBufferedBytes + addedBytes <= this.hostMaxBytes &&
      this.retainedBytes + processBufferedBytes + addedBytes <= this.processMaxBytes
    )
  }

  private deleteEmptyHost(browserHostClientId: string, host: BrowserHostMemoryState): void {
    if (
      host.leases === 0 &&
      host.claims === 0 &&
      host.bufferedSources.size === 0 &&
      this.hosts.get(browserHostClientId) === host
    ) {
      this.hosts.delete(browserHostClientId)
    }
  }
}

function readBufferedBytes(sources: Set<() => number>): number {
  let total = 0
  for (const read of sources) {
    try {
      const bytes = read()
      if (!Number.isSafeInteger(bytes) || bytes < 0) {
        return Number.POSITIVE_INFINITY
      }
      total += bytes
      if (!Number.isSafeInteger(total)) {
        return Number.POSITIVE_INFINITY
      }
    } catch {
      return Number.POSITIVE_INFINITY
    }
  }
  return total
}

function createRelease(release: () => void): () => void {
  let released = false
  return () => {
    if (released) {
      return
    }
    released = true
    release()
  }
}
