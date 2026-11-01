// Default-tab names belong to tabs; headless phone status must still use the agent's own titles.
import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { createMinimalPersistedTerminalTab } from '../persistence/restoring-sessions/session-owner-fields'
import { buildHeadlessMobileSessionTerminalTabs } from './mobile-session-terminal-projection'
import type { RuntimeNotifier } from './runtime-notifier-contract'
import type { RuntimeStore } from './runtime-store-contract'
import type { TerminalWorkspaceLaunchScope } from './runtime-legacy-worker-terminal-recovery-types'
import { provisionWorktreeTerminals } from './runtime-worktree-terminal-provisioning'
import { applyCommandToSession } from '../persistence/terminal-topology/terminal-pane-admission'
import { resolveHostId } from '../persistence/loading-store/session-host-partitions'
import { withRuntimePaneAdmission } from './runtime-durable-store-fixture'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../shared/layout-owner-switch'
import { committingSpawn } from './bind-first-pane.test-fixture'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') }
}))

const WORKTREE_ID = 'wt-1'
const AGENT_TAB_ID = 'agent-tab'
const AGENT_LEAF_ID = '11111111-1111-4111-8111-111111111111'
const AGENT_PTY_ID = 'pty-agent'

class DefaultTabRuntime extends OrcaRuntimeService {
  constructor(
    store: RuntimeStore | null,
    private readonly connectionId: string | null
  ) {
    super(store)
  }

  override async resolveTerminalWorkspaceLaunchScope(): Promise<TerminalWorkspaceLaunchScope> {
    return {
      id: WORKTREE_ID,
      path: '/repo/app',
      connectionId: this.connectionId,
      repo: null,
      folderWorkspace: null
    }
  }

  provisioningHost() {
    return this.getWorktreeTerminalProvisioningHost()
  }

  ptyTitle(ptyId: string): string | null | undefined {
    return this.ptysById.get(ptyId)?.title
  }
}

function sessionStore(initial: WorkspaceSessionState): {
  store: RuntimeStore
  getSession: () => WorkspaceSessionState
} {
  let session = initial
  const store: RuntimeStore = {
    getRepos: () => [],
    getRepo: () => undefined,
    addRepo: vi.fn<RuntimeStore['addRepo']>(),
    updateRepo: vi.fn<RuntimeStore['updateRepo']>(),
    getAllWorktreeMeta: () => ({}),
    getWorktreeMeta: () => undefined,
    setWorktreeMeta: vi.fn<RuntimeStore['setWorktreeMeta']>(),
    removeWorktreeMeta: vi.fn<RuntimeStore['removeWorktreeMeta']>(),
    getGitHubCache: vi.fn<RuntimeStore['getGitHubCache']>(),
    getWorkspaceSession: () => session,
    setWorkspaceSession: (next) => {
      session = next
    },
    applyLayoutCommand: async (command, hostIds = []) => {
      const change = applyCommandToSession(resolveHostId(hostIds[0]), session, command)
      session = change.session ?? session
      return change.value
    },
    getSettings: () => ({
      workspaceDir: '/workspaces',
      nestWorkspaces: false,
      refreshLocalBaseRefOnWorktreeCreate: false,
      branchPrefix: 'none',
      branchPrefixCustom: ''
    })
  }
  // Main-owned default-tab writes require the pane admission store.
  return {
    store: ORCA_LAYOUT_OWNER_IS_MAIN ? withRuntimePaneAdmission(store) : store,
    getSession: () => session
  }
}

function notifierWithRename(renameTerminal: RuntimeNotifier['renameTerminal']): RuntimeNotifier {
  return {
    worktreesChanged: vi.fn(),
    reposChanged: vi.fn(),
    activateWorktree: vi.fn(),
    createTerminal: vi.fn(),
    splitTerminal: vi.fn(),
    renameTerminal,
    focusTerminal: vi.fn(),
    closeTerminal: vi.fn(),
    terminalFitOverrideChanged: vi.fn(),
    terminalDriverChanged: vi.fn()
  }
}

async function createHeadlessRuntimeWithAgent(
  connectionId: string | null = null,
  store: RuntimeStore = sessionStore(getDefaultWorkspaceSession()).store
): Promise<{ runtime: DefaultTabRuntime; handle: string }> {
  const runtime = new DefaultTabRuntime(store, connectionId)
  let spawned = 0
  runtime.setPtyController({
    spawn: vi.fn(
      committingSpawn(runtime, async () => ({
        id: spawned++ === 0 ? AGENT_PTY_ID : `pty-${spawned}`
      }))
    ),
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null
  })
  const agent = await runtime.createTerminal(`id:${WORKTREE_ID}`, {
    tabId: AGENT_TAB_ID,
    leafId: AGENT_LEAF_ID,
    launchAgent: 'claude'
  })
  return { runtime, handle: agent.handle }
}

async function dressAgentTab(runtime: DefaultTabRuntime, handle: string): Promise<void> {
  // Cross-host provisioning receives only a handle; the owning host resolves its tab.
  await provisionWorktreeTerminals(runtime.provisioningHost(), {
    worktreeSelector: `id:${WORKTREE_ID}`,
    worktreeId: WORKTREE_ID,
    worktreePath: '/repo/app',
    defaultTabs: {
      runCommands: true,
      tabs: [{ title: 'Dev', command: 'pnpm dev', color: '#ff0000' }]
    },
    primaryTerminalHandle: handle,
    hasStartupTerminal: true,
    setupCommandPlatform: 'posix'
  })
}

function expectWindowTitledDev(
  renameTerminal: ReturnType<typeof vi.fn>,
  session: WorkspaceSessionState
): void {
  if (ORCA_LAYOUT_OWNER_IS_MAIN) {
    const row = session.tabsByWorktree[WORKTREE_ID]?.find((tab) => tab.id === AGENT_TAB_ID)
    expect(row?.customTitle).toBe('Dev')
    return
  }
  expect(renameTerminal).toHaveBeenCalledWith(AGENT_TAB_ID, 'Dev', { recordInteraction: false })
}

async function agentTab(runtime: OrcaRuntimeService) {
  const result = await runtime.listMobileSessionTabs(`id:${WORKTREE_ID}`)
  const tab = result.tabs.find(
    (candidate) => candidate.type === 'terminal' && candidate.parentTabId === AGENT_TAB_ID
  )
  if (tab?.type !== 'terminal') {
    throw new Error('expected the agent terminal tab')
  }
  return tab
}

describe('the agent tab a host-side create dresses as the first default tab', () => {
  it.each([
    ['a local', null],
    ['an SSH', 'ssh-1']
  ])(
    'gives %s agent tab the template title and color before the agent titles itself',
    async (_, connectionId) => {
      const { runtime, handle } = await createHeadlessRuntimeWithAgent(connectionId)
      await dressAgentTab(runtime, handle)

      expect(await agentTab(runtime)).toEqual(
        expect.objectContaining({ title: 'Dev', color: '#ff0000' })
      )
    }
  )

  it("keeps the phone's status on the agent's own titles", async () => {
    const { runtime, handle } = await createHeadlessRuntimeWithAgent()
    await dressAgentTab(runtime, handle)

    runtime.onPtyData(AGENT_PTY_ID, '\x1b]0;⠋ Claude\x07', Date.now())

    expect((await agentTab(runtime)).agentStatus).toEqual(
      expect.objectContaining({ state: 'working' })
    )
  })

  it('titles the tab, never the pane, and keeps the title across a restart', async () => {
    // Spawn binding has already persisted the agent tab before provisioning.
    const { store, getSession } = sessionStore({
      ...getDefaultWorkspaceSession(),
      tabsByWorktree: {
        [WORKTREE_ID]: [
          createMinimalPersistedTerminalTab({
            worktreeId: WORKTREE_ID,
            tabId: AGENT_TAB_ID,
            ptyId: AGENT_PTY_ID,
            existingTabCount: 0
          })
        ]
      }
    })
    const { runtime, handle } = await createHeadlessRuntimeWithAgent(null, store)
    const renameTerminal = vi.fn()
    runtime.setNotifier(notifierWithRename(renameTerminal))

    await dressAgentTab(runtime, handle)

    expectWindowTitledDev(renameTerminal, getSession())
    expect(runtime.ptyTitle(AGENT_PTY_ID)).toBeNull()
    const session = getSession()
    expect(
      buildHeadlessMobileSessionTerminalTabs(
        WORKTREE_ID,
        session.tabsByWorktree[WORKTREE_ID] ?? [],
        session
      )
    ).toEqual([
      expect.objectContaining({ parentTabId: AGENT_TAB_ID, title: 'Dev', color: '#ff0000' })
    ])
  })

  it("still titles the tab once the window's graph has taken over the handle", async () => {
    const { store, getSession } = sessionStore(getDefaultWorkspaceSession())
    const { runtime, handle } = await createHeadlessRuntimeWithAgent(null, store)
    const renameTerminal = vi.fn()
    runtime.setNotifier(notifierWithRename(renameTerminal))
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: AGENT_TAB_ID,
          worktreeId: WORKTREE_ID,
          title: 'Terminal',
          activeLeafId: AGENT_LEAF_ID,
          layout: null
        }
      ],
      leaves: [
        {
          tabId: AGENT_TAB_ID,
          worktreeId: WORKTREE_ID,
          leafId: AGENT_LEAF_ID,
          paneRuntimeId: 1,
          ptyId: AGENT_PTY_ID
        }
      ]
    })

    await runtime.provisioningHost().setTabTitle(handle, 'Dev')

    expectWindowTitledDev(renameTerminal, getSession())
  })
})
