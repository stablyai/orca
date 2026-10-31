import { afterEach, expect, it, vi } from 'vitest'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import type { ExecutionHostId } from '../../shared/execution-host'
import type { Tab } from '../../shared/tab-types'
import type { TerminalTab } from '../../shared/terminal-tab-types'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { setStructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-registry'
import { buildHeadlessMobileSessionTerminalTabs } from './mobile-session-terminal-projection'

// Preserve side-effect order: mocks, lifecycle, fixtures.
const { OrcaRuntimeService } = await import('./orca-runtime-test-mocks.spec')
await import('./orca-runtime-test-lifecycle.spec')
const { store, TEST_WORKTREE_ID, HEADLESS_LEAF_ID, makeRuntimeStoreWithWorkspaceSession } =
  await import('./orca-runtime-test-fixtures.spec')

afterEach(() => setStructuredAgentSessionHost(null))

it("publishes the desktop's chat tab name over the saved name, and the saved name once cleared", () => {
  let session: WorkspaceSessionState = getDefaultWorkspaceSession()
  const listeners = new Set<(hostId: ExecutionHostId | null) => void>()
  const runtime = new OrcaRuntimeService({
    ...store,
    getWorkspaceSession: () => session,
    onWorkspaceSessionWritten: (listener: (hostId: ExecutionHostId | null) => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    }
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: title projection reads only the record from this host stub.
  setStructuredAgentSessionHost({
    deps: {
      store: {
        getConversation: () => ({
          location: { workspaceId: TEST_WORKTREE_ID },
          conversationName: 'auth/login'
        })
      }
    }
  } as never)
  runtime.projectStructuredAgentSessionTab({
    activate: true,
    sessionId: 'session-1',
    workspaceId: TEST_WORKTREE_ID,
    agent: 'claude'
  })
  const titles: string[] = []
  runtime.onMobileSessionTabsChanged((snapshot) => {
    const tab = snapshot.tabs.find((candidate) => candidate.type === 'agent-session')
    if (tab) {
      titles.push(tab.title)
    }
  })
  const saveChatLabel = (customLabel: string | null): void => {
    const chat: Tab = {
      id: 'chat-tab',
      entityId: 'session-1',
      groupId: 'group-1',
      worktreeId: TEST_WORKTREE_ID,
      contentType: 'agent-session',
      label: 'Claude Chat',
      customLabel,
      color: null,
      sortOrder: 0,
      createdAt: 0
    }
    session = { ...session, unifiedTabs: { [TEST_WORKTREE_ID]: [chat] } }
    listeners.forEach((listener) => listener(null))
  }

  saveChatLabel('Release notes')
  saveChatLabel(null)

  expect(titles).toEqual(['Release notes', 'auth/login'])
})

async function listRestartedHeadlessCursorTab(
  generatedTitlesEnabled: boolean,
  liveFrame: string | null
): Promise<unknown> {
  const { runtimeStore, getSession, setSession } = makeRuntimeStoreWithWorkspaceSession(
    getDefaultWorkspaceSession()
  )
  const runtime = new OrcaRuntimeService({
    ...runtimeStore,
    getSettings: () => ({
      ...runtimeStore.getSettings(),
      tabAutoGenerateTitle: generatedTitlesEnabled
    })
  })
  runtime.setPtyController({
    spawn: vi.fn().mockResolvedValue({ id: 'cursor-pty' }),
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null
  })
  await runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, {
    tabId: 'cursor-tab',
    leafId: HEADLESS_LEAF_ID,
    launchAgent: 'cursor'
  })
  const session = getSession()
  setSession({
    ...session,
    tabsByWorktree: {
      ...session.tabsByWorktree,
      [TEST_WORKTREE_ID]: (session.tabsByWorktree[TEST_WORKTREE_ID] ?? []).map((tab) =>
        tab.id === 'cursor-tab' ? { ...tab, title: 'bash', generatedTitle: 'Fix tab titles' } : tab
      )
    }
  })
  runtime.hydrateHeadlessMobileSessionTabsFromWorkspaceSession(TEST_WORKTREE_ID, { force: true })
  if (liveFrame) {
    runtime.onPtyData('cursor-pty', `\x1b]0;${liveFrame}\x07`, Date.now())
  }
  return (await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)).tabs[0]
}

it("publishes a headless tab's generated name over the agent's live frames", async () => {
  expect(await listRestartedHeadlessCursorTab(true, '⠋ Cursor Agent')).toEqual(
    expect.objectContaining({ title: 'Fix tab titles' })
  )
})

const LEAF_A = '11111111-1111-4111-8111-111111111111'
const LEAF_B = '22222222-2222-4222-8222-222222222222'

it("keeps a headless split's tab-wide names off its panes, as the window does", () => {
  const tab: TerminalTab = {
    id: 'split-tab',
    ptyId: null,
    worktreeId: TEST_WORKTREE_ID,
    title: 'bash',
    quickCommandLabel: 'Run tests',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 0
  }
  const session: WorkspaceSessionState = {
    ...getDefaultWorkspaceSession(),
    terminalLayoutsByTabId: {
      'split-tab': {
        root: {
          type: 'split',
          direction: 'vertical',
          first: { type: 'leaf', leafId: LEAF_A },
          second: { type: 'leaf', leafId: LEAF_B }
        },
        activeLeafId: LEAF_A,
        expandedLeafId: null,
        titlesByLeafId: { [LEAF_A]: 'api-server', [LEAF_B]: 'bash' }
      }
    }
  }

  const rows = buildHeadlessMobileSessionTerminalTabs(TEST_WORKTREE_ID, [tab], session, true)

  expect(rows.map((row) => [row.title, row.quickCommandLabel])).toEqual([
    ['api-server', undefined],
    ['bash', undefined]
  ])
})
