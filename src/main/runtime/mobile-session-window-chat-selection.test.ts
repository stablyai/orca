import { describe, expect, it } from 'vitest'
import type { RuntimeMobileSessionTabsSnapshot } from '../../shared/runtime-types'
import { OrcaRuntimeService } from './orca-runtime'

const WORKTREE = 'repo-1::/tmp/worktree-a'
const FIRST_CHAT = 'agent-session:first'
const CHOSEN_CHAT = 'agent-session:chosen'

describe('window chat selection in host inventory', () => {
  it.each([false, true])(
    'keeps the chosen chat when the first chat previously reported active=%s',
    async (activateFirst) => {
      const runtime = new OrcaRuntimeService()
      runtime.projectStructuredAgentSessionTab({
        workspaceId: WORKTREE,
        sessionId: 'first',
        agent: 'claude',
        activate: activateFirst
      })
      runtime.projectStructuredAgentSessionTab({
        workspaceId: WORKTREE,
        sessionId: 'chosen',
        agent: 'codex',
        activate: false
      })

      const snapshot: RuntimeMobileSessionTabsSnapshot = {
        worktree: WORKTREE,
        publicationEpoch: 'renderer:test',
        snapshotVersion: 1,
        activeGroupId: 'group-1',
        activeTabId: null,
        activeTabType: null,
        tabGroups: [
          { id: 'group-1', activeTabId: CHOSEN_CHAT, tabOrder: [FIRST_CHAT, CHOSEN_CHAT] }
        ],
        tabs: []
      }
      const publish = (next: RuntimeMobileSessionTabsSnapshot): void => {
        runtime.syncWindowGraph(1, { tabs: [], leaves: [], mobileSessionTabs: [next] })
      }
      publish(snapshot)
      // A later background create and graph publication must keep the same visible chat.
      runtime.projectStructuredAgentSessionTab({
        workspaceId: WORKTREE,
        sessionId: 'background',
        agent: 'claude',
        activate: false
      })
      publish({
        ...snapshot,
        snapshotVersion: 2,
        tabGroups: [
          {
            id: 'group-1',
            activeTabId: CHOSEN_CHAT,
            tabOrder: [FIRST_CHAT, CHOSEN_CHAT, 'agent-session:background']
          }
        ]
      })

      const listed = await runtime.listMobileSessionTabs(`id:${WORKTREE}`)
      expect(listed.activeTabId).toBe(CHOSEN_CHAT)
      expect(listed.activeTabType).toBe('agent-session')
      expect(listed.tabGroups?.[0]?.activeTabId).toBe(CHOSEN_CHAT)
      expect(listed.tabs.filter((tab) => tab.isActive).map((tab) => tab.id)).toEqual([CHOSEN_CHAT])
    }
  )

  it('uses the focused group rather than the first split group', async () => {
    const runtime = new OrcaRuntimeService()
    for (const sessionId of ['first', 'chosen']) {
      runtime.projectStructuredAgentSessionTab({
        workspaceId: WORKTREE,
        sessionId,
        agent: 'claude',
        activate: sessionId === 'first'
      })
    }
    runtime.syncWindowGraph(1, {
      tabs: [],
      leaves: [],
      mobileSessionTabs: [
        {
          worktree: WORKTREE,
          publicationEpoch: 'renderer:test',
          snapshotVersion: 1,
          activeGroupId: 'group-2',
          activeTabId: null,
          activeTabType: null,
          tabGroups: [
            { id: 'group-1', activeTabId: FIRST_CHAT, tabOrder: [FIRST_CHAT] },
            { id: 'group-2', activeTabId: CHOSEN_CHAT, tabOrder: [CHOSEN_CHAT] }
          ],
          tabs: []
        }
      ]
    })

    const listed = await runtime.listMobileSessionTabs(`id:${WORKTREE}`)
    expect(listed.activeGroupId).toBe('group-2')
    expect(listed.activeTabId).toBe(CHOSEN_CHAT)
    expect(listed.tabs.filter((tab) => tab.isActive).map((tab) => tab.id)).toEqual([CHOSEN_CHAT])
    expect(listed.tabGroups?.map((group) => group.activeTabId)).toEqual([FIRST_CHAT, CHOSEN_CHAT])
  })

  it('retains host selection when an older window publishes no group selection', async () => {
    const runtime = new OrcaRuntimeService()
    runtime.projectStructuredAgentSessionTab({
      workspaceId: WORKTREE,
      sessionId: 'chosen',
      agent: 'claude',
      activate: true
    })
    runtime.syncWindowGraph(1, {
      tabs: [],
      leaves: [],
      mobileSessionTabs: [
        {
          worktree: WORKTREE,
          publicationEpoch: 'renderer:test',
          snapshotVersion: 1,
          activeGroupId: null,
          activeTabId: null,
          activeTabType: null,
          tabs: []
        }
      ]
    })

    const listed = await runtime.listMobileSessionTabs(`id:${WORKTREE}`)
    expect(listed.activeTabId).toBe(CHOSEN_CHAT)
    expect(listed.tabs.filter((tab) => tab.isActive).map((tab) => tab.id)).toEqual([CHOSEN_CHAT])
  })
})
