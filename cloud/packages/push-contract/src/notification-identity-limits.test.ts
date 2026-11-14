import { expect, it } from 'vitest'
import { PushNotificationSchema } from './send-messages.js'
const base = {
  source: 'agent-task-complete',
  agentState: 'finished',
  notificationSeq: 1,
  notificationEpoch: 'epoch',
  title: 'Done',
  body: ''
}
it('rejects oversized provider data by UTF-8 bytes instead of truncating identities', () => {
  expect(PushNotificationSchema.safeParse({ ...base, worktreeId: '界'.repeat(1100) }).success).toBe(
    false
  )
})
