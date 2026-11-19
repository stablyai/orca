import { expect, it } from 'vitest'
import { AgentConversationCopyStartError } from '../../../../../native-chat/conversation-adoption/agent-conversation-copy-error'
import { resolveUncommittedStructuredCreate } from './structured-agent-session-precommit-refusal'

it('preserves a confirmed native child and uncertainty when copy preparation fails before attach', async () => {
  const result = await resolveUncommittedStructuredCreate(async () => {
    throw new AgentConversationCopyStartError(
      'Codex created chat native-child. Retry will reopen this saved copy.'
    )
  }, 'codex')
  expect(result).toEqual({
    refusal: {
      code: 'agent_session_operation_unknown',
      message: 'Codex created chat native-child. Retry will reopen this saved copy.',
      details: { reason: 'outcomeUnknown' }
    }
  })
})
