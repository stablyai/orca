import { describe, expect, it, vi } from 'vitest'
import { createRelayRecoveryLog } from './mobile-relay-recovery-log'
import type { ConnectionLogEntry } from './types'

describe('createRelayRecoveryLog', () => {
  it('uses distinct ids across logger instances', () => {
    const entries: ConnectionLogEntry[] = []
    const sink = vi.fn((entry: ConnectionLogEntry) => entries.push(entry))
    createRelayRecoveryLog(() => 1, sink)('first')
    createRelayRecoveryLog(() => 1, sink)('second')

    expect(entries[0]?.id).not.toBe(entries[1]?.id)
  })
})
