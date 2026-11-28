import { sessionTabPaneKey } from '../../../../src/shared/remote-runtime/session-graph/session-tab-pane-key'
import { expect, it } from 'vitest'
import {
  persistNotificationReplyDraft,
  notificationReplyPaneDraftScope,
  restoreNotificationReplyDrafts
} from './notification-reply-draft-handoff'
import { durableDraftRow, resetDurableDraftRowsForTests } from '../../drafts/durable-draft-rows'
import { appendReturnedDraftText } from '../../../../src/shared/native-chat/input/drafts/returned-draft-text'

it('persists handoffs before restoration and retires them only after the receiving draft is durable', async () => {
  const disk = new Map<string, string>()
  const store = {
    read: async (_table: 'draft' | 'cache', keys: readonly string[]) =>
      ({ status: 'ok', values: keys.map((key) => disk.get(key) ?? null) }) as const,
    write: async (
      _table: 'draft' | 'cache',
      ops: readonly { key: string; value: string | null }[]
    ) => {
      for (const op of ops) {
        if (op.value === null) {
          disk.delete(op.key)
        } else {
          disk.set(op.key, op.value)
        }
      }
      return { written: true } as const
    }
  }
  const leaf = '372e1f92-beaa-40fc-b46a-268b814bf3cf'
  const paneKey = `tab:${leaf}`
  const scope = notificationReplyPaneDraftScope('paired', 'workspace', paneKey)
  const projected = sessionTabPaneKey({
    type: 'terminal',
    id: `tab::${leaf}`,
    parentTabId: 'tab',
    leafId: leaf
  })
  expect(notificationReplyPaneDraftScope('paired', 'workspace', projected!)).toBe(scope)
  await Promise.all([
    persistNotificationReplyDraft(store, scope, 'a'.repeat(64), 'first failed reply'),
    persistNotificationReplyDraft(store, scope, 'b'.repeat(64), 's'.repeat(32_001))
  ])
  // A refused destination write must leave both handoffs available for a new page.
  await restoreNotificationReplyDrafts(store, scope, async () => false)
  let text = ''
  const page = () =>
    durableDraftRow('draft:receiving-comment', {
      backend: () => ({
        read: async () => ({ ok: true, value: disk.get('draft:receiving-comment') ?? null }),
        write: async (value) => {
          disk.set('draft:receiving-comment', String(value))
          return true
        }
      }),
      snapshot: () => text,
      restore: (saved) => {
        if (typeof saved === 'string') {
          text = saved
        }
      }
    })
  let row = page()
  await row.load()
  await restoreNotificationReplyDrafts(store, scope, async (reply) => {
    text = appendReturnedDraftText(text, reply)
    return row.persist()
  })
  expect(text).toBe('first failed reply\n\n' + 's'.repeat(32_001))
  resetDurableDraftRowsForTests()
  text = ''
  row = page()
  await row.load()
  await restoreNotificationReplyDrafts(store, scope, async (reply) => {
    text = appendReturnedDraftText(text, reply)
    return row.persist()
  })
  expect(text).toBe('first failed reply\n\n' + 's'.repeat(32_001))
  resetDurableDraftRowsForTests()
})
