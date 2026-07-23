export const MAX_USAGE_HISTORY_FILES = 200_000
export const MAX_USAGE_HISTORY_DISCOVERY_ENTRIES = 1_000_000
export const MAX_USAGE_HISTORY_RECORDS = 100_000
export const MAX_USAGE_HISTORY_OWNERSHIP_KEYS = 100_000
export const MAX_USAGE_HISTORY_RETAINED_BYTES = 256 * 1024 * 1024

const FILE_COLLECTION_ENTRY_BYTES = 160
const OWNERSHIP_COLLECTION_ENTRY_BYTES = 160
const RECORD_PIPELINE_BYTES = 1024
const PROJECTION_ENTRY_BYTES = 256
const STRING_HEADER_BYTES = 32

type UsageHistoryScanLimits = {
  files: number
  discoveryEntries: number
  records: number
  ownershipKeys: number
  retainedBytes: number
}

const DEFAULT_LIMITS: UsageHistoryScanLimits = {
  files: MAX_USAGE_HISTORY_FILES,
  discoveryEntries: MAX_USAGE_HISTORY_DISCOVERY_ENTRIES,
  records: MAX_USAGE_HISTORY_RECORDS,
  ownershipKeys: MAX_USAGE_HISTORY_OWNERSHIP_KEYS,
  retainedBytes: MAX_USAGE_HISTORY_RETAINED_BYTES
}

export class UsageHistoryScanCapacityError extends Error {
  constructor(
    readonly resource: keyof UsageHistoryScanLimits,
    readonly limit: number
  ) {
    super(`Usage history scan exceeded ${limit} ${resource}`)
    this.name = 'UsageHistoryScanCapacityError'
  }
}

export class UsageHistoryScanBudget {
  private readonly limits: UsageHistoryScanLimits
  private readonly used: UsageHistoryScanLimits = {
    files: 0,
    discoveryEntries: 0,
    records: 0,
    ownershipKeys: 0,
    retainedBytes: 0
  }

  constructor(limits: Partial<UsageHistoryScanLimits> = {}) {
    this.limits = { ...DEFAULT_LIMITS, ...limits }
  }

  claimFile(path: string): void {
    this.claim('files', 1)
    this.claimPath(path)
  }

  claimDiscoveryEntry(): void {
    this.claim('discoveryEntries', 1)
  }

  claimRecord(retainedBytes: number): void {
    this.claim('records', 1)
    this.claim('retainedBytes', RECORD_PIPELINE_BYTES + retainedBytes)
  }

  claimRecords(count: number): void {
    this.claim('records', count)
    this.claim('retainedBytes', RECORD_PIPELINE_BYTES * count)
  }

  claimRetainedBytes(bytes: number): void {
    this.claim('retainedBytes', bytes)
  }

  claimPath(path: string): void {
    this.claim('retainedBytes', FILE_COLLECTION_ENTRY_BYTES + getUsageHistoryRetainedBytes([path]))
  }

  claimProjection(retainedStringBytes: number): void {
    this.claim('retainedBytes', PROJECTION_ENTRY_BYTES + retainedStringBytes)
  }

  claimOwnershipKey(key: string): void {
    this.claim('ownershipKeys', 1)
    this.claim(
      'retainedBytes',
      OWNERSHIP_COLLECTION_ENTRY_BYTES + getUsageHistoryRetainedBytes([key])
    )
  }

  private claim(resource: keyof UsageHistoryScanLimits, amount: number): void {
    if (!Number.isSafeInteger(amount) || amount < 0) {
      throw new UsageHistoryScanCapacityError(resource, this.limits[resource])
    }
    if (amount > this.limits[resource] - this.used[resource]) {
      throw new UsageHistoryScanCapacityError(resource, this.limits[resource])
    }
    this.used[resource] += amount
  }
}

export function getUsageHistoryRetainedBytes(values: readonly (string | null)[]): number {
  let bytes = 0
  for (const value of values) {
    if (value !== null) {
      bytes += STRING_HEADER_BYTES + value.length * 2
    }
  }
  return bytes
}
