import { describe, expect, it } from 'vitest'
import type { RuntimeMobileSessionSnapshotTab } from '../../shared/runtime-types'
import { appendChatTabOrder } from './session-lifecycle/projection/mobile-session-tab-merge'

const chat: RuntimeMobileSessionSnapshotTab = {
  type: 'agent-session',
  id: 'agent-session:claude_a',
  title: 'Claude',
  sessionId: 'claude_a',
  agent: 'claude',
  isActive: true
}
const terminal: RuntimeMobileSessionSnapshotTab = {
  type: 'terminal',
  id: 'term::leaf',
  parentTabId: 'term',
  leafId: 'leaf',
  title: 'Terminal',
  isActive: true
}

describe('chat tabs across a rebuild from persisted state', () => {
  it('returns a chat to the place it held, not the end', () => {
    const groups = appendChatTabOrder(
      [{ id: 'g', activeTabId: 'term', tabOrder: ['term', 'other'] }],
      [{ id: 'g', activeTabId: chat.id, tabOrder: [chat.id, 'term', 'editor', 'other'] }],
      [chat, terminal]
    )

    expect(groups).toEqual([{ id: 'g', activeTabId: 'term', tabOrder: [chat.id, 'term', 'other'] }])
  })

  it('follows the tab it sat after when that tab survives', () => {
    const groups = appendChatTabOrder(
      [{ id: 'g', activeTabId: 'term', tabOrder: ['term', 'other'] }],
      [{ id: 'g', activeTabId: 'term', tabOrder: ['term', chat.id, 'other'] }],
      [{ ...chat, isActive: false }, terminal]
    )

    expect(groups[0]?.tabOrder).toEqual(['term', chat.id, 'other'])
    expect(groups[0]?.activeTabId).toBe('term')
  })
})
