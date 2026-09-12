import { describe, expect, it } from 'vitest'
import { isAgentSessionRecord } from '../../shared/agent-session-record'
import { agentSessionRecordFixture } from '../../shared/agent-session-record.test-fixture'
import { setAgentSessionRecordConversationName } from './agent-session-record-conversation-name'

const NOW = 9_000

describe('agent session record conversationName validation', () => {
  it('accepts a record carrying a bounded name', () => {
    expect(
      isAgentSessionRecord({
        ...agentSessionRecordFixture(),
        conversationName: 'Fix the lease probe'
      })
    ).toBe(true)
  })

  it('accepts a record with no name at all', () => {
    expect(isAgentSessionRecord(agentSessionRecordFixture())).toBe(true)
  })

  it('rejects a name past the stored maximum', () => {
    expect(
      isAgentSessionRecord({ ...agentSessionRecordFixture(), conversationName: 'a'.repeat(201) })
    ).toBe(false)
  })

  it('rejects a name that is not a string', () => {
    expect(isAgentSessionRecord({ ...agentSessionRecordFixture(), conversationName: 42 })).toBe(
      false
    )
    expect(isAgentSessionRecord({ ...agentSessionRecordFixture(), conversationName: '' })).toBe(
      false
    )
  })

  it('rejects persisted names that bypassed canonical normalization', () => {
    expect(
      isAgentSessionRecord({
        ...agentSessionRecordFixture(),
        conversationName: 'Fix\u202Egnp.exe probe'
      })
    ).toBe(false)
    expect(
      isAgentSessionRecord({ ...agentSessionRecordFixture(), conversationName: 'Fix\nthe probe' })
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
    expect(isAgentSessionRecord(next)).toBe(true)
  })

  it('normalizes on the way in so the record stays valid whatever the caller sent', () => {
    const next = setAgentSessionRecordConversationName(
      agentSessionRecordFixture(),
      `Fix\nthe  probe`,
      NOW
    )

    expect(next.conversationName).toBe('Fix the probe')
    expect(isAgentSessionRecord(next)).toBe(true)
  })

  it('bounds an over-long name rather than storing a record the validator would reject', () => {
    const next = setAgentSessionRecordConversationName(
      agentSessionRecordFixture(),
      'a'.repeat(1000),
      NOW
    )

    expect(next.conversationName).toHaveLength(200)
    expect(isAgentSessionRecord(next)).toBe(true)
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
    expect(isAgentSessionRecord(cleared)).toBe(true)
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
