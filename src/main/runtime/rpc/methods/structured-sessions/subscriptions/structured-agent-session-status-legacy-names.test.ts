import { describe, expect, it } from 'vitest'
import { agentSessionRecordFixture } from '../../../../../../shared/agent-session/lifecycle/records/agent-session-record.test-fixture'
import { agentSessionConversationView } from '../../../../../../shared/agent-session/lifecycle/leases/agent-session-conversation-view'
import { legacyClosedChatNameRows } from './structured-agent-session-status-legacy-names'

const named = agentSessionConversationView({
  ...agentSessionRecordFixture(),
  conversationName: 'Saved title'
})

describe('legacyClosedChatNameRows', () => {
  it('gives a paired client without record names its closed chats named rows', () => {
    expect(legacyClosedChatNameRows({ clientKind: 'runtime' }, [], [named])).toEqual([
      expect.objectContaining({ sessionId: named.sessionId, conversationName: 'Saved title' })
    ])
  })

  it('sends nothing extra to a client that reads record names', () => {
    expect(
      legacyClosedChatNameRows(
        { clientKind: 'runtime', clientCapabilities: ['agent-session.record-names.v1'] },
        [],
        [named]
      )
    ).toEqual([])
  })
})
