import { expect, it, vi } from 'vitest'
import type { RuntimeMobileSessionTabsResult } from '../../shared/runtime-types'

vi.mock('../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: false }))
const { OrcaRuntimeService, electronMocks } = await import('./orca-runtime-test-mocks.spec')
await import('./orca-runtime-test-lifecycle.spec')
const { store, TEST_WORKTREE_ID: WT } = await import('./orca-runtime-test-fixtures.spec')

it.each([false, true])(
  'publishes a phone fork beside its source with a window layout owner, missing anchor=%s',
  async (missing) => {
    const runtime = new OrcaRuntimeService(store)
    electronMocks.BrowserWindow.fromId.mockReturnValue({
      isDestroyed: () => false,
      webContents: {
        isDestroyed: () => false,
        setBackgroundThrottling: vi.fn(),
        capturePage: async () => undefined
      }
    })
    runtime.attachWindow(1)
    const chat = (sessionId: string) => ({
      type: 'agent-session' as const,
      id: `agent-session:${sessionId}`,
      title: sessionId,
      sessionId,
      agent: 'claude' as const,
      isActive: sessionId === 'active'
    })
    const frames: RuntimeMobileSessionTabsResult[] = []
    runtime.onMobileSessionTabsChanged((snapshot) => frames.push(snapshot), 'phone', 'mobile')
    runtime.syncWindowGraph(1, {
      tabs: [],
      leaves: [],
      mobileSessionTabs: [
        {
          worktree: WT,
          publicationEpoch: 'window:fork-source',
          snapshotVersion: 1,
          activeGroupId: 'other-group',
          activeTabId: 'agent-session:active',
          activeTabType: 'agent-session',
          tabGroups: [
            {
              id: 'source-group',
              activeTabId: 'agent-session:source',
              tabOrder: ['agent-session:source', 'agent-session:B']
            },
            {
              id: 'other-group',
              activeTabId: 'agent-session:active',
              tabOrder: ['agent-session:active']
            }
          ],
          tabs: [chat('source'), chat('B'), chat('active')]
        }
      ]
    })
    await runtime.publishStructuredAgentSessionTab({
      workspaceId: WT,
      sessionId: 'child',
      agent: 'claude',
      activate: false,
      placement: { afterTabId: missing ? 'closed-source' : 'agent-session:source' }
    })
    runtime.selectCreatedMobileSessionTabForClient(WT, { sessionId: 'child' }, 'phone')
    const frame = frames.at(-1)!
    expect(frame.activeGroupId).toBe(missing ? 'other-group' : 'source-group')
    expect(frame.tabGroups?.find((group) => group.id === 'source-group')?.tabOrder).toEqual(
      missing
        ? ['agent-session:source', 'agent-session:B']
        : ['agent-session:source', 'agent-session:child', 'agent-session:B']
    )
    expect(frame.tabGroups?.find((group) => group.id === 'other-group')?.tabOrder).toEqual(
      missing ? ['agent-session:active', 'agent-session:child'] : ['agent-session:active']
    )
    expect(
      frame.tabs.filter((tab) => tab.id !== 'agent-session:active').map((tab) => tab.id)
    ).toEqual(
      missing
        ? ['agent-session:source', 'agent-session:B', 'agent-session:child']
        : ['agent-session:source', 'agent-session:child', 'agent-session:B']
    )
  }
)
