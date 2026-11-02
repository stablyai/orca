import { describe, expect, it, vi } from 'vitest'
import { testOrcaSessionId } from '../../../shared/orca-session-address-test-fixture'
import { canonicalOrcaSessionId } from './canonical-orca-session-id'
import type { AgentSessionRecordReader } from './structured-session-lineage'

const ROOT = testOrcaSessionId('1f0c2a3b-4d5e-4f60-8a71-b2c3d4e5f601')
const CLEARED = testOrcaSessionId('2a1b3c4d-5e6f-4a70-9b81-c2d3e4f5a602')

describe('canonical session identity', () => {
  it('reads every record once per store revision, however many sessions it names', () => {
    const records = [
      {
        sessionId: ROOT,
        conversationCommand: { command: 'clear', phase: 'committed', replacementSessionId: CLEARED }
      },
      { sessionId: CLEARED }
    ]
    let revision = {}
    const listRecords = vi.fn(() => records)
    const store = { listRecords, revision: () => revision } as unknown as Pick<
      AgentSessionRecordReader,
      'listRecords' | 'revision'
    >
    for (let check = 0; check < 40; check += 1) {
      expect(canonicalOrcaSessionId(CLEARED, store)).toBe(ROOT)
    }
    expect(listRecords).toHaveBeenCalledTimes(1)
    // A write publishes a new revision: the next lookup sees it.
    revision = {}
    expect(canonicalOrcaSessionId(ROOT, store)).toBe(ROOT)
    expect(listRecords).toHaveBeenCalledTimes(2)
  })
})
