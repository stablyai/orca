import { expect, it } from 'vitest'
import { queuedStructuredChatAction } from './structured-agent-session-chat-action'

it('reclassifies a queued slash-text command edited into a human message', () => {
  expect(
    queuedStructuredChatAction({
      chatAction: 'command',
      body: {
        kind: 'message',
        role: 'user',
        blocks: [{ type: 'text', text: 'Please explain this code' }]
      }
    })
  ).toBe('message')
})
