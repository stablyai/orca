import { expect, it } from 'vitest'
import { agentSessionFailureSentence } from '../../../src/shared/agent-session/failures/agent-session-failure-words'
import { sayMobileAgentSessionFailure } from './agent-session-failure-copy'

it('gives new-chat guidance while keeping a missing conversation diagnostic private', () => {
  expect(
    agentSessionFailureSentence(
      {
        kind: 'savedConversationMissing',
        detail: { text: 'No conversation found with session ID: private-id', audience: 'log' }
      },
      'row',
      { agentName: 'Claude' },
      sayMobileAgentSessionFailure
    )
  ).toBe("Claude couldn't find this chat's saved conversation. Start a new chat to continue.")
})
