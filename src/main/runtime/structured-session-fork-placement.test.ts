import { expect, it, vi } from 'vitest'
import type {
  RuntimeMobileSessionTabsResult,
  RuntimeMobileSessionTabsSnapshot
} from '../../shared/runtime-types'
import type { Tab } from '../../shared/tab-types'
import type { WorkspaceSessionState } from '../../shared/workspace-session/workspace-session-state-types'

vi.mock('../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: false }))
const { OrcaRuntimeService, electronMocks } = await import('./orca-runtime-test-mocks.spec')
await import('./orca-runtime-test-lifecycle.spec')
const { makeRuntimeStoreWithWorkspaceSession, TEST_WORKTREE_ID: WT } =
  await import('./orca-runtime-test-fixtures.spec')

type Anchor = 'ordinary' | 'missing' | 'reopened' | 'stale-reopened' | 'old-alias'
const REOPENED = 'agent-chat-tab-v1-current-source'
const rawId = (sessionId: string) => `agent-session:${sessionId}`
const savedId = (sessionId: string) => `structured-agent-session-${sessionId}`
const sourceId = (anchor: Anchor, saved = false) =>
  ['reopened', 'stale-reopened', 'old-alias'].includes(anchor)
    ? REOPENED
    : saved
      ? savedId('source')
      : rawId('source')
const capturedAnchor = (anchor: Anchor) =>
  anchor === 'missing'
    ? rawId('closed-source')
    : anchor === 'stale-reopened'
      ? 'agent-chat-tab-v1-closed-source'
      : anchor === 'reopened'
        ? REOPENED
        : rawId('source')

function savedSession(anchor: Anchor, listed: boolean): WorkspaceSessionState {
  const tab = (sessionId: string, groupId: string): Tab => ({
    id: sessionId === 'source' ? sourceId(anchor, true) : savedId(sessionId),
    entityId: sessionId,
    contentType: 'agent-session',
    agentSessionAgent: 'claude',
    executionHostId: 'local',
    worktreeId: WT,
    groupId,
    label: sessionId,
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 1
  })
  return {
    activeRepoId: null,
    activeWorktreeId: WT,
    activeTabId: null,
    tabsByWorktree: {},
    terminalLayoutsByTabId: {},
    unifiedTabs: {
      [WT]: [
        tab('source', 'G1'),
        tab('B', 'G1'),
        tab('active', 'G2'),
        ...(listed ? [tab('child', 'G2')] : [])
      ]
    },
    tabGroups: {
      [WT]: [
        {
          id: 'G1',
          worktreeId: WT,
          activeTabId: sourceId(anchor, true),
          tabOrder: [sourceId(anchor, true), savedId('B')]
        },
        {
          id: 'G2',
          worktreeId: WT,
          activeTabId: savedId('active'),
          tabOrder: [savedId('active'), ...(listed ? [savedId('child')] : [])]
        }
      ]
    },
    activeGroupIdByWorktree: { [WT]: 'G2' },
    tabGroupLayouts: {
      [WT]: {
        type: 'split',
        direction: 'horizontal',
        ratio: 0.5,
        first: { type: 'leaf', groupId: 'G1' },
        second: { type: 'leaf', groupId: 'G2' }
      }
    }
  }
}

function rawSnapshot(anchor: Anchor, listed: boolean): RuntimeMobileSessionTabsSnapshot {
  const chat = (sessionId: string) => ({
    type: 'agent-session' as const,
    id: sessionId === 'source' ? sourceId(anchor) : rawId(sessionId),
    title: sessionId,
    sessionId,
    agent: 'claude' as const,
    isActive: sessionId === 'active'
  })
  return {
    worktree: WT,
    publicationEpoch: 'window:fork-source',
    snapshotVersion: 1,
    activeGroupId: 'G2',
    activeTabId: rawId('active'),
    activeTabType: 'agent-session',
    tabGroups: [
      { id: 'G1', activeTabId: sourceId(anchor), tabOrder: [sourceId(anchor), rawId('B')] },
      {
        id: 'G2',
        activeTabId: rawId('active'),
        tabOrder: [rawId('active'), ...(listed ? [rawId('child')] : [])]
      }
    ],
    tabs: [chat('source'), chat('B'), chat('active'), ...(listed ? [chat('child')] : [])]
  }
}

for (const owner of ['saved', 'window'] as const) {
  it.each([
    ['ordinary', false],
    ['missing', false],
    ['reopened', false],
    ['stale-reopened', false],
    ['old-alias', false],
    ['ordinary', true]
  ] as const)(
    `places a phone fork at the ${owner} owner, anchor=%s, already listed=%s`,
    async (anchor, listed) => {
      const fixture = makeRuntimeStoreWithWorkspaceSession(savedSession(anchor, listed))
      const runtime = new OrcaRuntimeService(fixture.runtimeStore)
      const before = JSON.stringify(fixture.getSession())
      if (owner === 'window') {
        electronMocks.BrowserWindow.fromId.mockReturnValue({
          isDestroyed: () => false,
          webContents: {
            isDestroyed: () => false,
            setBackgroundThrottling: vi.fn(),
            capturePage: async () => undefined
          }
        })
        runtime.attachWindow(1)
        runtime.syncWindowGraph(1, {
          tabs: [],
          leaves: [],
          mobileSessionTabs: [rawSnapshot(anchor, listed)]
        })
      } else {
        runtime.storeMobileSessionSnapshot(WT, rawSnapshot(anchor, listed))
      }
      const frames: RuntimeMobileSessionTabsResult[] = []
      runtime.onMobileSessionTabsChanged((snapshot) => frames.push(snapshot), 'phone', 'mobile')
      await runtime.publishStructuredAgentSessionTab({
        workspaceId: WT,
        sessionId: 'child',
        agent: 'claude',
        activate: false,
        placement: { afterTabId: capturedAnchor(anchor) }
      })
      runtime.selectCreatedMobileSessionTabForClient(WT, { sessionId: 'child' }, 'phone')
      const fallback = listed || !['ordinary', 'reopened'].includes(anchor)
      const check = (frame: Pick<RuntimeMobileSessionTabsSnapshot, 'tabGroups'>) => {
        expect(frame.tabGroups?.map((group) => [group.id, group.tabOrder])).toEqual([
          [
            'G1',
            fallback
              ? [sourceId(anchor), rawId('B')]
              : [sourceId(anchor), rawId('child'), rawId('B')]
          ],
          ['G2', fallback ? [rawId('active'), rawId('child')] : [rawId('active')]]
        ])
      }
      check(frames.at(-1)!)
      if (owner === 'window') {
        expect(JSON.stringify(fixture.getSession())).toBe(before)
      } else {
        expect(
          fixture.getSession().tabGroups?.[WT]?.map((group) => [group.id, group.tabOrder])
        ).toEqual([
          [
            'G1',
            fallback
              ? [sourceId(anchor, true), savedId('B')]
              : [sourceId(anchor, true), savedId('child'), savedId('B')]
          ],
          ['G2', fallback ? [savedId('active'), savedId('child')] : [savedId('active')]]
        ])
        // Reload the saved shape, then restore raw rows through the ordinary projection path.
        const reload = makeRuntimeStoreWithWorkspaceSession(
          JSON.parse(JSON.stringify(fixture.getSession()))
        )
        const restarted = new OrcaRuntimeService(reload.runtimeStore)
        for (const sessionId of ['source', 'B', 'active', 'child']) {
          restarted.projectStructuredAgentSessionTab({
            workspaceId: WT,
            sessionId,
            agent: 'claude',
            activate: false,
            tabId: sessionId === 'source' ? sourceId(anchor, true) : savedId(sessionId)
          })
        }
        await restarted.publishStructuredAgentSessionTab({
          workspaceId: WT,
          sessionId: 'child',
          agent: 'claude',
          activate: false,
          placement: { afterTabId: capturedAnchor(anchor) }
        })
        check(restarted.mobileSessionTabsByWorktree.get(WT)!)
      }
    }
  )
}
