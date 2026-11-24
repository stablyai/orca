// Forgetting an idle chat for good takes its ended mark with it, so ended ids never outgrow the chats.
import { describe, expect, it } from 'vitest'
import {
  agentSessionLeaseFixture,
  agentSessionRecordFixture
} from '../../../../shared/agent-session/lifecycle/records/agent-session-record.test-fixture'
import { forgetIdleAgentSessionRecord } from './agent-session-record-forget'
import { AgentSessionTabTable } from './agent-session-tab-index'
import type { AgentSessionStoreState } from './agent-session-store-state'

describe('forgetting an ended chat', () => {
  it('drops its ended mark with its record, leaving other ended chats', () => {
    const record = agentSessionRecordFixture(
      agentSessionLeaseFixture({
        sessionId: 'gone',
        claimStatus: 'released',
        ownerProcess: null,
        deathEvidence: { kind: 'exit-observed', detail: 'closed by Orca', observedAt: 1 }
      })
    )
    const tabs = new AgentSessionTabTable([], [], ['gone', 'kept'])
    const state: AgentSessionStoreState = {
      records: new Map([['gone', record]]),
      operations: new Map(),
      retiredClaimKeys: [],
      unreadableRecords: new Map(),
      sessionTabs: tabs
    }

    expect(
      forgetIdleAgentSessionRecord(
        state,
        { sessionId: 'gone', location: record.location, idleBefore: Number.MAX_SAFE_INTEGER },
        []
      )
    ).toBe(true)
    expect(state.records.has('gone')).toBe(false)
    expect(tabs.endedSessionIds()).toEqual(['kept'])
  })
})
