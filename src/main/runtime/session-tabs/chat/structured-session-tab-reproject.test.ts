import { describe, expect, it } from 'vitest'
import type { RuntimeMobileSessionTabsSnapshot } from '../../../../shared/remote-runtime/session-graph/runtime-session-contracts'
import { projectStructuredSessionTab } from './structured-session-tab-publication'

describe('projecting reopened chats into a workspace that has no tab snapshot yet', () => {
  it('adds one row per chat in call order, inactive, and emits each change', () => {
    const snapshots = new Map<string, RuntimeMobileSessionTabsSnapshot>()
    const runtime = {
      mobileSessionTabsByWorktree: snapshots,
      storeMobileSessionSnapshot: (id: string, snapshot: RuntimeMobileSessionTabsSnapshot) => {
        snapshots.set(id, snapshot)
        return snapshot
      }
    }
    const emitted: RuntimeMobileSessionTabsSnapshot[] = []
    for (const sessionId of ['chat-b', 'chat-a']) {
      projectStructuredSessionTab(
        runtime as never,
        { workspaceId: 'new-id::/work/app', sessionId, agent: 'claude', activate: false },
        (snapshot) => emitted.push(snapshot)
      )
    }
    const rows = snapshots
      .get('new-id::/work/app')
      ?.tabs.flatMap((tab) => (tab.type === 'agent-session' ? [tab.sessionId] : []))
    expect(rows).toEqual(['chat-b', 'chat-a'])
    expect(emitted).toHaveLength(2)
    expect(snapshots.get('new-id::/work/app')?.tabs.some((tab) => tab.isActive)).toBe(false)
  })
})
