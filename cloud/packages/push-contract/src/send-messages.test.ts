import { describe, expect, it } from 'vitest'
import { PUSH_PROMPT_DECISION_CATEGORY, PushNotificationSchema } from './send-messages.js'

const notification = {
  notificationEpoch: 'epoch',
  notificationSeq: 1,
  source: 'agent-task-complete' as const,
  agentState: 'needs-input' as const,
  title: 'Needs you',
  body: 'Allow?'
}

describe('PushNotificationSchema prompt replies', () => {
  it('accepts short Allow and Deny keys and rejects a long one', () => {
    expect(
      PushNotificationSchema.safeParse({
        ...notification,
        promptReply: { allow: '1', deny: '\u001b' }
      }).success
    ).toBe(true)
    expect(
      PushNotificationSchema.safeParse({
        ...notification,
        promptReply: { allow: 'yes please', deny: 'n' }
      }).success
    ).toBe(false)
  })

  it('names the category the phone registers for those buttons', () => {
    expect(PUSH_PROMPT_DECISION_CATEGORY).toBe('orca.prompt-decision')
  })
})
