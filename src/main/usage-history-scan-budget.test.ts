import { describe, expect, it } from 'vitest'
import {
  MAX_USAGE_HISTORY_DISCOVERY_ENTRIES,
  MAX_USAGE_HISTORY_FILES,
  MAX_USAGE_HISTORY_OWNERSHIP_KEYS,
  MAX_USAGE_HISTORY_RECORDS,
  MAX_USAGE_HISTORY_RETAINED_BYTES,
  UsageHistoryScanBudget,
  UsageHistoryScanCapacityError
} from './usage-history-scan-budget'

describe('UsageHistoryScanBudget', () => {
  it('publishes the production scan limits', () => {
    expect({
      files: MAX_USAGE_HISTORY_FILES,
      discoveryEntries: MAX_USAGE_HISTORY_DISCOVERY_ENTRIES,
      records: MAX_USAGE_HISTORY_RECORDS,
      ownershipKeys: MAX_USAGE_HISTORY_OWNERSHIP_KEYS,
      retainedBytes: MAX_USAGE_HISTORY_RETAINED_BYTES
    }).toEqual({
      files: 200_000,
      discoveryEntries: 1_000_000,
      records: 100_000,
      ownershipKeys: 100_000,
      retainedBytes: 256 * 1024 * 1024
    })
  })

  it('accepts exact limits and fails closed before each collection can grow past them', () => {
    const files = new UsageHistoryScanBudget({ files: 2, retainedBytes: 10_000 })
    files.claimFile('a')
    files.claimFile('b')
    expect(() => files.claimFile('c')).toThrowError(
      expect.objectContaining({ resource: 'files', limit: 2 })
    )

    const entries = new UsageHistoryScanBudget({ discoveryEntries: 2 })
    entries.claimDiscoveryEntry()
    entries.claimDiscoveryEntry()
    expect(() => entries.claimDiscoveryEntry()).toThrow(UsageHistoryScanCapacityError)

    const records = new UsageHistoryScanBudget({ records: 2, retainedBytes: 10_000 })
    records.claimRecord(1)
    records.claimRecord(1)
    expect(() => records.claimRecord(1)).toThrowError(
      expect.objectContaining({ resource: 'records', limit: 2 })
    )

    const keys = new UsageHistoryScanBudget({ ownershipKeys: 2, retainedBytes: 10_000 })
    keys.claimOwnershipKey('a')
    keys.claimOwnershipKey('b')
    expect(() => keys.claimOwnershipKey('c')).toThrowError(
      expect.objectContaining({ resource: 'ownershipKeys', limit: 2 })
    )

    const bytes = new UsageHistoryScanBudget({ retainedBytes: 2 })
    bytes.claimRetainedBytes(2)
    expect(() => bytes.claimRetainedBytes(1)).toThrowError(
      expect.objectContaining({ resource: 'retainedBytes', limit: 2 })
    )
  })

  it('charges conservative collection overhead for many tiny values', () => {
    const records = new UsageHistoryScanBudget({ records: 100, retainedBytes: 10 * 1024 })
    for (let index = 0; index < 10; index++) {
      records.claimRecord(0)
    }
    expect(() => records.claimRecord(0)).toThrowError(
      expect.objectContaining({ resource: 'retainedBytes', limit: 10 * 1024 })
    )

    const paths = new UsageHistoryScanBudget({ files: 100, retainedBytes: 1_940 })
    for (let index = 0; index < 10; index++) {
      paths.claimFile('a')
    }
    expect(() => paths.claimFile('b')).toThrowError(
      expect.objectContaining({ resource: 'retainedBytes', limit: 1_940 })
    )
  })
})
