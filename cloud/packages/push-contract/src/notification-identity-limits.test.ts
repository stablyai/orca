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
it.each([
  'repo::/Users/developer/orca/workspaces/monorepo/packages/desktop/integrations/feature-mobile-background-notifications',
  'repo::C:\\Users\\developer\\Documents\\projects\\monorepo\\packages\\desktop\\feature-mobile-notifications',
  'folder::/home/developer/projects/通知/作業ディレクトリ/機能',
  'ssh:host::/home/developer/workspaces/monorepo/packages/desktop/feature-mobile-background-notifications'
])('preserves long desktop identities: %s', (path) => {
  const worktreeId = `12345678-1234-1234-1234-123456789012::${path}`
  const notificationId = [
    'agent',
    encodeURIComponent(worktreeId),
    encodeURIComponent('12345678-1234-1234-1234-123456789012:87654321-4321-4321-4321-210987654321'),
    '1780000000123'
  ].join(':')
  const result = PushNotificationSchema.parse({ ...base, worktreeId, notificationId })
  expect(result.worktreeId).toBe(worktreeId)
  expect(result.notificationId).toBe(notificationId)
})
it('rejects oversized provider data by UTF-8 bytes instead of truncating identities', () => {
  expect(PushNotificationSchema.safeParse({ ...base, worktreeId: '界'.repeat(1100) }).success).toBe(
    false
  )
})
