import { describe, expect, it, vi } from 'vitest'
import {
  agentSessionLeaseFixture,
  agentSessionRecordFixture
} from '../../../shared/agent-session-record.test-fixture'
import type { StructuredAgentSessionHandoffDeps } from './structured-agent-session-handoff-types'
import { closeRetainedTuiOwner } from './structured-agent-session-handoff-owner-close'

const NOW = 1_800_000_000_000

describe('closeRetainedTuiOwner', () => {
  it('does not latch unexpected-exit settlement after an intentional close', async () => {
    let record = agentSessionRecordFixture(agentSessionLeaseFixture())
    const closeTuiOwner = vi.fn(async () => ({}))
    const releaseOwner = vi.fn()
    const owner = {
      terminal: { handle: 'terminal-1', tabId: 'tab-1', paneKey: 'pane-1', ptyId: 'pty-1' },
      process: record.lease.ownerProcess!,
      link: record.providerHandleChain[0]!
    }
    const deps = {
      store: {
        transitionHandoff: async (
          _sessionId: string,
          transition: (current: typeof record) => typeof record
        ) => {
          record = transition(record)
          return record
        }
      },
      transport: { closeTuiOwner },
      now: () => NOW
    } as unknown as StructuredAgentSessionHandoffDeps

    await closeRetainedTuiOwner({
      sessionId: record.sessionId,
      deps,
      owner: () => owner,
      requireRecord: () => record,
      releaseOwner
    })

    expect(closeTuiOwner).toHaveBeenCalledWith(owner)
    expect(releaseOwner).toHaveBeenCalledWith(record.sessionId)
    expect(record.lease).toMatchObject({
      claimStatus: 'released',
      deathEvidence: { kind: 'exit-observed' }
    })
    expect(record.lease.settlementRetryRequired).toBeUndefined()
    expect(record.lease.settlementRetryId).toBeUndefined()
  })
})
