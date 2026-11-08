import { expect, it } from 'vitest'
import { queuedStructuredChatAction } from './structured-agent-session-chat-action'

it.each(['command', 'continue'] as const)(
  'reclassifies a queued %s edited into a human message',
  (chatAction) => {
    expect(
      queuedStructuredChatAction({
        chatAction,
        body: {
          kind: 'message',
          role: 'user',
          blocks: [{ type: 'text', text: 'Please explain this code' }]
        }
      })
    ).toBe('message')
  }
)
