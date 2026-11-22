import { describe, expect, it } from 'vitest'
import { buildNotificationOptions } from './notification-options'

const translate = (_key: string, fallback: string): string => fallback
const reply = 'Pinged <!here> and <@U12345ABC|sam>.'

describe('agent completion notification body', () => {
  it('shows Slack mentions as names only for a chat answering a Slack thread', () => {
    const request = {
      source: 'agent-task-complete' as const,
      agentType: 'claude' as const,
      agentState: 'done' as const,
      agentLastAssistantMessage: reply
    }
    expect(
      buildNotificationOptions({ ...request, agentRepliesInSlack: true }, translate).body
    ).toBe('Pinged @here and @sam.')
    expect(buildNotificationOptions(request, translate).body).toBe(reply)
  })
})
