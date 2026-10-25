import { describe, expect, it } from 'vitest'
import { structuredCompactionOutcome } from './structured-conversation-command-outcome'

describe('structuredCompactionOutcome', () => {
  it('is a success only when the provider reported the compaction', () => {
    expect(structuredCompactionOutcome({ compacted: true, interruptRequested: true })).toEqual({
      outcome: 'success'
    })
  })

  it("reads no compaction after Orca's interrupt as the user's cancellation", () => {
    expect(
      structuredCompactionOutcome({
        compacted: false,
        interruptRequested: true,
        failed: { detail: { text: 'API Error: Request was aborted.', audience: 'person' } }
      })
    ).toEqual({ outcome: 'cancellation' })
  })

  it("reads a failure the provider reported as a failed compaction, keeping the provider's words", () => {
    expect(
      structuredCompactionOutcome({
        compacted: false,
        interruptRequested: false,
        failed: { detail: { text: 'Not enough messages to compact.', audience: 'person' } }
      })
    ).toEqual({
      outcome: 'failure',
      failure: {
        kind: 'compactionFailed',
        detail: { text: 'Not enough messages to compact.', audience: 'person' }
      }
    })
    expect(
      structuredCompactionOutcome({ compacted: false, interruptRequested: false, failed: {} })
    ).toEqual({ outcome: 'failure', failure: { kind: 'compactionFailed' } })
  })

  it('reads a compaction the provider never reported as a failure it did not confirm', () => {
    expect(structuredCompactionOutcome({ compacted: false, interruptRequested: false })).toEqual({
      outcome: 'failure',
      failure: { kind: 'compactionUnconfirmed' }
    })
  })
})
