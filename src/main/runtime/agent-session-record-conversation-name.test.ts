import { describe, expect, it } from 'vitest'
import {
  isPersistedAgentSessionRecord,
  type AgentSessionRecord
} from '../../shared/agent-session-record'
import { encodePersistedAgentSessionProviderHandleChain } from '../../shared/agent-session-provider-handle'
import { agentSessionRecordFixture } from '../../shared/agent-session-record.test-fixture'
import { setAgentSessionRecordConversationName } from './agent-session-record-conversation-name'

const NOW = 9_000

/** Validates the record as its row stores it. */
function storedRecordIsValid(
  record: Omit<AgentSessionRecord, 'conversationName'> & { conversationName?: unknown }
): boolean {
  return isPersistedAgentSessionRecord({
    ...record,
    providerHandleChain: encodePersistedAgentSessionProviderHandleChain(record.providerHandleChain)
  })
}

describe('agent session record conversationName validation', () => {
  it('accepts a record carrying a bounded name', () => {
    expect(
      storedRecordIsValid({
        ...agentSessionRecordFixture(),
        conversationName: 'Fix the lease probe'
      })
    ).toBe(true)
  })

  it('accepts a record with no name at all', () => {
    expect(storedRecordIsValid(agentSessionRecordFixture())).toBe(true)
  })

  it('rejects a name past the stored maximum', () => {
    expect(
      storedRecordIsValid({
        ...agentSessionRecordFixture(),
        conversationName: 'a'.repeat(201)
      })
    ).toBe(false)
  })

  it('rejects a name that is not a string', () => {
    expect(storedRecordIsValid({ ...agentSessionRecordFixture(), conversationName: 42 })).toBe(
      false
    )
    expect(storedRecordIsValid({ ...agentSessionRecordFixture(), conversationName: '' })).toBe(
      false
    )
  })

  it('rejects persisted names that bypassed canonical normalization', () => {
    expect(
      storedRecordIsValid({
        ...agentSessionRecordFixture(),
        conversationName: 'Fix\u202Egnp.exe probe'
      })
    ).toBe(false)
    expect(
      storedRecordIsValid({
        ...agentSessionRecordFixture(),
        conversationName: 'Fix\nthe probe'
      })
    ).toBe(false)
  })
})

describe('setAgentSessionRecordConversationName', () => {
  it('sets the name and stamps the update', () => {
    const next = setAgentSessionRecordConversationName(
      agentSessionRecordFixture(),
      'Fix the lease probe',
      NOW
    )

    expect(next.conversationName).toBe('Fix the lease probe')
    expect(next.updatedAt).toBe(NOW)
    expect(storedRecordIsValid(next)).toBe(true)
  })

  it('normalizes on the way in so the record stays valid whatever the caller sent', () => {
    const next = setAgentSessionRecordConversationName(
      agentSessionRecordFixture(),
      `Fix\nthe  probe`,
      NOW
    )

    expect(next.conversationName).toBe('Fix the probe')
    expect(storedRecordIsValid(next)).toBe(true)
  })

  it('bounds an over-long name rather than storing a record the validator would reject', () => {
    const next = setAgentSessionRecordConversationName(
      agentSessionRecordFixture(),
      'a'.repeat(1000),
      NOW
    )

    expect(next.conversationName).toHaveLength(200)
    expect(storedRecordIsValid(next)).toBe(true)
  })

  it('clears the name via null, deleting the key rather than storing an empty string', () => {
    const named = setAgentSessionRecordConversationName(
      agentSessionRecordFixture(),
      'Fix the probe',
      NOW
    )

    const cleared = setAgentSessionRecordConversationName(named, null, NOW + 1)

    expect(Object.hasOwn(cleared, 'conversationName')).toBe(false)
    expect(cleared.updatedAt).toBe(NOW + 1)
    expect(storedRecordIsValid(cleared)).toBe(true)
  })

  it('treats a name that normalizes to nothing as a clear', () => {
    const named = setAgentSessionRecordConversationName(
      agentSessionRecordFixture(),
      'Fix the probe',
      NOW
    )

    expect(
      Object.hasOwn(
        setAgentSessionRecordConversationName(named, '   ', NOW + 1),
        'conversationName'
      )
    ).toBe(false)
  })

  it('returns the same object when the name is unchanged, so no write is provoked', () => {
    const named = setAgentSessionRecordConversationName(
      agentSessionRecordFixture(),
      'Fix the probe',
      NOW
    )

    expect(setAgentSessionRecordConversationName(named, 'Fix the probe', NOW + 1)).toBe(named)
  })

  it('returns the same object when clearing a record that has no name', () => {
    const record = agentSessionRecordFixture()

    expect(setAgentSessionRecordConversationName(record, null, NOW)).toBe(record)
  })
})
