import { describe, expect, it } from 'vitest'
import {
  agentSessionLeaseFixture,
  agentSessionRecordFixture
} from '../../../../shared/agent-session/lifecycle/records/agent-session-record.test-fixture'
import {
  decodePersistedAgentSessionRecord,
  encodeAgentSessionRecord
} from '../../../../shared/agent-session/lifecycle/records/agent-session-record-stored-form'
import {
  agentSessionInstructionsContext,
  recordAgentSessionInstructionsKey
} from './agent-session-instructions-receipt'
import {
  type AgentSessionConversationClear,
  commitConversationClearRecord
} from './agent-session-conversation-command-record'
import type { AgentSessionStoreState } from './agent-session-store-state'
import { recordAgentSessionProviderHandle } from '../ownership/agent-session-provider-handle-transition'
import {
  agentSessionProviderHandleKey,
  claudeProviderHandle
} from '../../../../shared/agent-session/lifecycle/provider-handles/agent-session-provider-handle-encoding'
import { commitAgentSessionRewindCompletion } from './agent-session-rewind-completion'
import type { AgentSessionRewindRecord } from '../../../../shared/agent-session/lifecycle/rewind/agent-session-rewind'

const live = agentSessionRecordFixture()
const receipt = {
  sessionId: live.sessionId,
  fence: 7,
  key: 'new-key',
  context: agentSessionInstructionsContext(live)
}

describe('the receipt that a provider context holds the host instructions', () => {
  it('is written by the owner that sent them, into the context they were sent to', () => {
    expect(recordAgentSessionInstructionsKey(live, receipt).instructionsKey).toBe('new-key')
  })

  it('is not written after another owner took the session over', () => {
    const takenOver = agentSessionRecordFixture(agentSessionLeaseFixture({ runtimeFence: 8 }))
    expect(recordAgentSessionInstructionsKey(takenOver, receipt).instructionsKey).toBeUndefined()
  })

  it('is not written into a context a /clear started after the turn was planned', () => {
    const cleared = {
      ...live,
      providerContextBoundary: { operationId: 'clear-1', afterFence: 7, clearedAt: 5 }
    }
    expect(recordAgentSessionInstructionsKey(cleared, receipt).instructionsKey).toBeUndefined()
  })

  it('is not written into another provider conversation opened at the same fence', () => {
    const forked = recordAgentSessionProviderHandle({
      record: live,
      fence: 7,
      now: 5,
      link: {
        linkId: 'link-2',
        origin: 'forked',
        mintedAtFence: 7,
        observedAt: 4,
        handle: claudeProviderHandle('different-context', null),
        forkedFromKey: agentSessionProviderHandleKey(live.providerHandleChain[0].handle)
      }
    })
    expect(recordAgentSessionInstructionsKey(forked, receipt).instructionsKey).toBeUndefined()
  })

  it('is dropped by /clear', () => {
    const atRest = agentSessionRecordFixture(
      agentSessionLeaseFixture({ ownerProcess: null, claimStatus: 'released' })
    )
    const records = new Map([[atRest.sessionId, { ...atRest, instructionsKey: 'old-key' }]])
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a /clear commit reads and writes only `records`.
    const state = { records } as unknown as AgentSessionStoreState
    const command = {
      command: 'clear',
      phase: 'committed',
      state: 'completed',
      callerKey: 'c',
      operationId: 'o'
    }
    const clear = { sessionId: atRest.sessionId, fence: 7, command, now: 10 }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the commit reads only the command's caller key and operation id.
    commitConversationClearRecord(state, clear as unknown as AgentSessionConversationClear)
    expect(state.records.get(atRest.sessionId)?.instructionsKey).toBeUndefined()
  })

  it('is dropped by a committed rewind', () => {
    const rewind: AgentSessionRewindRecord = {
      operationId: 'rewind-1',
      callerKey: 'c',
      itemId: 'item-3',
      expectedEpoch: 'epoch-1',
      phase: 'provider-succeeded'
    }
    const state: AgentSessionStoreState = {
      records: new Map([[live.sessionId, { ...live, rewind, instructionsKey: 'old-key' }]]),
      operations: new Map(),
      retiredClaimKeys: [],
      unreadableRecords: new Map(),
      sessionTabs: null
    }
    commitAgentSessionRewindCompletion(state, live.sessionId, 7, rewind, {
      epoch: 'epoch-2',
      sequence: 3
    })
    const rewound = state.records.get(live.sessionId)
    expect(rewound?.rewind?.phase).toBe('completed')
    expect(rewound?.instructionsKey).toBeUndefined()
  })

  it('is dropped alone when a stored one is malformed, keeping the record', () => {
    const stored = { ...encodeAgentSessionRecord(live), instructionsKey: 42 }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a stored row an older or broken writer left, which the decoder must tolerate.
    const { record } = decodePersistedAgentSessionRecord(stored as never)
    expect(record.instructionsKey).toBeUndefined()
    expect(record.sessionId).toBe(live.sessionId)
  })
})
