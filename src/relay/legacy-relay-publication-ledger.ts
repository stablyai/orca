export const LEGACY_CLIENT_RETAINED_BYTES_HIGH = 2 * 1024 * 1024
export const LEGACY_CLIENT_RETAINED_BYTES_LOW = 1024 * 1024
export const LEGACY_RELAY_RETAINED_BYTES_HIGH = 32 * 1024 * 1024
export const LEGACY_RELAY_RETAINED_BYTES_LOW = 24 * 1024 * 1024

export type LegacyPublicationLease = {
  clientKey: string
  bytes: number
  release: () => void
}

type LegacyPublicationLimits = {
  clientHighBytes?: number
  clientLowBytes?: number
  relayHighBytes?: number
  relayLowBytes?: number
}

export class LegacyRelayPublicationLedger {
  private readonly clientBytes = new Map<string, number>()
  private aggregateBytes = 0

  readonly clientHighBytes: number
  readonly clientLowBytes: number
  readonly relayHighBytes: number
  readonly relayLowBytes: number

  constructor(limits: LegacyPublicationLimits = {}) {
    this.clientHighBytes = limits.clientHighBytes ?? LEGACY_CLIENT_RETAINED_BYTES_HIGH
    this.clientLowBytes = limits.clientLowBytes ?? LEGACY_CLIENT_RETAINED_BYTES_LOW
    this.relayHighBytes = limits.relayHighBytes ?? LEGACY_RELAY_RETAINED_BYTES_HIGH
    this.relayLowBytes = limits.relayLowBytes ?? LEGACY_RELAY_RETAINED_BYTES_LOW
  }

  get retainedBytes(): number {
    return this.aggregateBytes
  }

  retainedBytesFor(clientKey: string): number {
    return this.clientBytes.get(clientKey) ?? 0
  }

  tryReserve(
    memberships: readonly { clientKey: string; bytes: number }[]
  ): LegacyPublicationLease[] | null {
    let aggregateAdded = 0
    const additions = new Map<string, number>()
    for (const membership of memberships) {
      if (!Number.isSafeInteger(membership.bytes) || membership.bytes < 0) {
        return null
      }
      aggregateAdded += membership.bytes
      additions.set(
        membership.clientKey,
        (additions.get(membership.clientKey) ?? 0) + membership.bytes
      )
    }
    if (this.aggregateBytes + aggregateAdded > this.relayHighBytes) {
      return null
    }
    for (const [clientKey, bytes] of additions) {
      if ((this.clientBytes.get(clientKey) ?? 0) + bytes > this.clientHighBytes) {
        return null
      }
    }
    this.aggregateBytes += aggregateAdded
    for (const [clientKey, bytes] of additions) {
      this.clientBytes.set(clientKey, (this.clientBytes.get(clientKey) ?? 0) + bytes)
    }
    return memberships.map(({ clientKey, bytes }) => {
      let released = false
      return {
        clientKey,
        bytes,
        release: () => {
          if (released) {
            return
          }
          released = true
          this.release(clientKey, bytes)
        }
      }
    })
  }

  belowLowWater(clientKeys?: readonly string[]): boolean {
    if (this.aggregateBytes > this.relayLowBytes) {
      return false
    }
    const keys = clientKeys ?? Array.from(this.clientBytes.keys())
    return keys.every((clientKey) => (this.clientBytes.get(clientKey) ?? 0) <= this.clientLowBytes)
  }

  private release(clientKey: string, bytes: number): void {
    const current = this.clientBytes.get(clientKey) ?? 0
    const next = Math.max(0, current - bytes)
    this.aggregateBytes = Math.max(0, this.aggregateBytes - Math.min(bytes, current))
    if (next === 0) {
      this.clientBytes.delete(clientKey)
    } else {
      this.clientBytes.set(clientKey, next)
    }
  }
}
