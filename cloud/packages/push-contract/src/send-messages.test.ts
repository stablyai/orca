import { describe, expect, it } from 'vitest'
import { PushSendRequestSchema } from './send-messages.js'

function notification(): Record<string, unknown> {
  return {
    notificationId: 'note-1',
    notificationSeq: 4,
    notificationEpoch: '5c9e9a1e-0000-4000-8000-000000000000',
    source: 'agent-task-complete',
    agentState: 'needs-input',
    title: 'Agent needs input',
    body: 'Waiting on your answer',
    worktreeId: 'wt-1'
  }
}

describe('send schemas', () => {

  it('rejects a notification id that could not be sent as a collapse header', () => {
    for (const notificationId of ['line\nbreak', 'nul\0byte', 'émoji', '\t']) {
      expect(
        PushSendRequestSchema.safeParse({
          v: 1,
          registrationIds: ['reg-1'],
          notification: { ...notification(), notificationId }
        }).success
      ).toBe(false)
    }
    expect(
      PushSendRequestSchema.safeParse({
        v: 1,
        registrationIds: ['reg-1'],
        notification: {
          ...notification(),
          notificationId: 'agent:repo%3A%3A%2FUsers%2Fme:pane-1:1700000000000'
        }
      }).success
    ).toBe(true)
  })
})
