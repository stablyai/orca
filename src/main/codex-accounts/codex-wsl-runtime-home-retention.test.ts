import { describe, expect, it } from 'vitest'
import { CodexWslRuntimeHomeRetention } from './codex-wsl-runtime-home-retention'

const BOUNDS = {
  maxEntries: 2,
  maxKeyBytes: 8,
  maxValueBytes: 8,
  maxTotalBytes: 18
}

describe('CodexWslRuntimeHomeRetention', () => {
  it('retains the coordinated state and distinguishes an explicit system account', () => {
    const retention = new CodexWslRuntimeHomeRetention(BOUNDS)
    retention.setRuntimeHomePath('a', '/home')
    retention.setLastWrittenAuthJson('a', 'auth')
    retention.setLastSyncedAccountId('a', null)

    expect(retention.getRuntimeHomePath('a')).toBe('/home')
    expect(retention.getLastWrittenAuthJson('a')).toBe('auth')
    expect(retention.hasLastSyncedAccountId('a')).toBe(true)
    expect(retention.getLastSyncedAccountId('a')).toBeNull()
  })

  it('evicts the least-recently-used distro at the entry bound', () => {
    const retention = new CodexWslRuntimeHomeRetention(BOUNDS)
    retention.setRuntimeHomePath('a', 'one')
    retention.setRuntimeHomePath('b', 'two')
    retention.getRuntimeHomePath('a')
    retention.setRuntimeHomePath('c', 'three')

    expect(retention.getRuntimeHomePath('a')).toBe('one')
    expect(retention.getRuntimeHomePath('b')).toBeUndefined()
    expect(retention.getRuntimeHomePath('c')).toBe('three')
    expect(retention.evidence().entries).toBe(2)
  })

  it('bounds aggregate retained bytes and fails closed for oversized fields', () => {
    const retention = new CodexWslRuntimeHomeRetention(BOUNDS)
    retention.setRuntimeHomePath('a', '12345678')
    retention.setRuntimeHomePath('b', '12345678')

    expect(retention.evidence()).toEqual({ entries: 2, retainedBytes: 18 })

    retention.setLastWrittenAuthJson('b', '123456789')

    expect(retention.getRuntimeHomePath('b')).toBeUndefined()
    expect(retention.evidence()).toEqual({ entries: 1, retainedBytes: 9 })
  })
})
