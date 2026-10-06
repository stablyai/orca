/**
 * Every host launch route finalizes a new agent tab's starting view once and commits it in the
 * tab's first durable admission; publication and reveal then read what the record committed.
 *
 * The PTY controller is a stub (no process starts): its spawn applies the same admission write the
 * real spawn commit does, so these tests exercise the runtime's routes, not a re-implementation.
 */

import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { applyPtyBinding } from '../persistence/loading-store/pty-binding-session-update'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import type { RuntimeMobileSessionTerminalTab } from '../../shared/runtime-types'
import { createExistingWorktreeWorkerTerminal } from './rpc/methods/orchestration/worker/worker-topology'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') }
}))

const WT = 'repo-1::/repo/app'
const CHAT_DEFAULT = { experimentalNativeChat: true, openAgentTabsInChatByDefault: true }
const TERMINAL_DEFAULT = { experimentalNativeChat: true, openAgentTabsInChatByDefault: false }
const EXISTING_TAB = 'existing-tab'
const EXISTING_LEAF = '11111111-1111-4111-8111-111111111111'
const NEW_LEAF = '22222222-2222-4222-8222-222222222222'

type SpawnArgs = {
  tabId: string
  leafId: string
  persistHostSessionBinding?: boolean
  startingViewMode?: 'terminal' | 'chat'
}

function harness(options: {
  settings: Record<string, unknown>
  session?: WorkspaceSessionState
  revealTerminalSession?: ReturnType<typeof vi.fn>
}) {
  const runtime = new OrcaRuntimeService()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the routes under test read these protected members; each is assigned or spied before a create reaches it.
  const internal = runtime as unknown as {
    store: { getSettings: () => Record<string, unknown> }
    resolveTerminalWorkspaceLaunchScope: (selector: string) => Promise<unknown>
    getWorkspaceSessionForWorktree: (worktreeId: string) => WorkspaceSessionState | null
    setWorkspaceSessionForWorktree: (worktreeId: string, next: WorkspaceSessionState) => void
    mobileSessionTabsByWorktree: Map<string, { tabs: RuntimeMobileSessionTerminalTab[] }>
    nudgeAgentExitCheck: (ptyId: string) => void
    noteAgentOwnerPresenceChange: (change: { paneKey: string; presence: null }) => void
  }
  let session = options.session ?? getDefaultWorkspaceSession()
  internal.store = { getSettings: () => options.settings }
  vi.spyOn(internal, 'resolveTerminalWorkspaceLaunchScope').mockResolvedValue({
    id: WT,
    path: '/repo/app',
    connectionId: null,
    repo: null,
    folderWorkspace: null
  })
  vi.spyOn(internal, 'getWorkspaceSessionForWorktree').mockImplementation(() => session)
  vi.spyOn(internal, 'setWorkspaceSessionForWorktree').mockImplementation((_id, next) => {
    session = next
  })
  let nextPty = 1
  const spawn = vi.fn(async (args: SpawnArgs) => {
    const ptyId = `pty-${nextPty++}`
    if (args.persistHostSessionBinding) {
      // The spawn commit's admission write: the first durable mutation for this tab.
      const next = structuredClone(session)
      applyPtyBinding(
        {
          worktreeId: WT,
          tabId: args.tabId,
          leafId: args.leafId,
          ptyId,
          hostAdmittedMembership: true,
          ...(args.startingViewMode ? { startingViewMode: args.startingViewMode } : {})
        },
        next,
        WT,
        `${args.tabId}:${args.leafId}`
      )
      session = next
    }
    return { id: ptyId }
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these routes call only spawn on this stub controller.
  runtime.setPtyController({
    spawn,
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null
  } as never)
  runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
  if (options.revealTerminalSession) {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the create routes call only revealTerminalSession.
    runtime.setNotifier({ revealTerminalSession: options.revealTerminalSession } as never)
  }
  const published = (tabId: string) =>
    internal.mobileSessionTabsByWorktree
      .get(WT)
      ?.tabs.find((tab) => tab.type === 'terminal' && tab.parentTabId === tabId)
  return { runtime, internal, spawn, getSession: () => session, published }
}

function sessionWithExistingUnswitchedTab(): WorkspaceSessionState {
  return {
    ...getDefaultWorkspaceSession(),
    tabsByWorktree: {
      [WT]: [
        {
          id: EXISTING_TAB,
          ptyId: 'old-pty',
          worktreeId: WT,
          title: 'Claude',
          customTitle: null,
          color: null,
          sortOrder: 0,
          createdAt: 1,
          launchAgent: 'claude'
        }
      ]
    },
    terminalLayoutsByTabId: {
      [EXISTING_TAB]: {
        root: { type: 'leaf', leafId: EXISTING_LEAF },
        activeLeafId: EXISTING_LEAF,
        expandedLeafId: null,
        ptyIdsByLeafId: { [EXISTING_LEAF]: 'old-pty' }
      }
    }
  }
}

describe('host agent launch routes stamp the starting view at creation', () => {
  it('agent.launch / CLI lane: the host default (chat) is in the admission and the publication', async () => {
    const { runtime, spawn, getSession, published } = harness({ settings: CHAT_DEFAULT })

    const created = await runtime.createTerminal(`id:${WT}`, {
      startupAgent: 'claude',
      presentation: 'background'
    })

    expect(spawn.mock.calls[0]?.[0]).toMatchObject({ startingViewMode: 'chat' })
    const tabId = created.tabId!
    const leafId = spawn.mock.calls[0]![0].leafId
    expect(getSession().tabsByWorktree[WT]?.find((tab) => tab.id === tabId)?.viewMode).toBe('chat')
    expect(getSession().terminalLayoutsByTabId[tabId]?.chatLeafId).toBe(leafId)
    expect(published(tabId)).toMatchObject({
      viewMode: 'chat',
      parentLayout: { chatLeafId: leafId }
    })
  })

  it('stamps a decided terminal (a pin) over a chat host default', async () => {
    const { runtime, spawn, getSession, published } = harness({ settings: CHAT_DEFAULT })

    const created = await runtime.createTerminal(`id:${WT}`, {
      startupAgent: 'claude',
      viewMode: 'terminal',
      presentation: 'background'
    })

    expect(spawn.mock.calls[0]?.[0]).toMatchObject({ startingViewMode: 'terminal' })
    expect(getSession().tabsByWorktree[WT]?.find((tab) => tab.id === created.tabId)?.viewMode).toBe(
      'terminal'
    )
    expect(published(created.tabId!)?.viewMode).toBe('terminal')
  })

  it('records nothing when the host default is terminal, so viewers keep their own default', async () => {
    const { runtime, spawn, published } = harness({ settings: TERMINAL_DEFAULT })

    const created = await runtime.createTerminal(`id:${WT}`, {
      startupAgent: 'codex',
      presentation: 'background'
    })

    expect(spawn.mock.calls[0]?.[0]).not.toHaveProperty('startingViewMode')
    expect(published(created.tabId!)?.viewMode).toBeUndefined()
  })

  it("applies the launching device's terminal default over a chat host: nothing recorded", async () => {
    const { runtime, spawn } = harness({ settings: CHAT_DEFAULT })

    await runtime.createTerminal(`id:${WT}`, {
      startupAgent: 'claude',
      launcherDefaultView: 'terminal',
      presentation: 'background'
    })

    expect(spawn.mock.calls[0]?.[0]).not.toHaveProperty('startingViewMode')
  })

  it('orchestration worker-start (STA-9293): reveals the committed chat with fresh-launch proof', async () => {
    const revealTerminalSession = vi.fn(async () => ({ tabId: 'ignored', title: '' }))
    const { runtime } = harness({ settings: CHAT_DEFAULT, revealTerminalSession })

    await createExistingWorktreeWorkerTerminal({
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: worker-start calls only createTerminal.
      runtime: runtime as never,
      worktreeId: WT,
      agent: 'claude',
      taskId: 'task-1',
      effects: []
    })

    expect(revealTerminalSession).toHaveBeenCalledWith(
      WT,
      expect.objectContaining({ launchAgent: 'claude', viewMode: 'chat', freshLaunchView: true })
    )
  })

  it('session.tabs.createTerminal on a headless host publishes the committed chat with its owner', async () => {
    const { runtime, getSession } = harness({ settings: CHAT_DEFAULT })

    const result = await runtime.createMobileSessionTerminal(`id:${WT}`, { agent: 'claude' })

    expect(result.tab).toMatchObject({
      viewMode: 'chat',
      parentLayout: { chatLeafId: result.tab.leafId }
    })
    const row = getSession().tabsByWorktree[WT]?.find((tab) => tab.id === result.tab.parentTabId)
    expect(row?.viewMode).toBe('chat')
  })

  it("session.tabs.createTerminal applies a phone's terminal default over a chat host on both passes", async () => {
    const { runtime, spawn, getSession } = harness({ settings: CHAT_DEFAULT })

    const result = await runtime.createMobileSessionTerminal(`id:${WT}`, {
      agent: 'claude',
      launcherDefaultView: 'terminal'
    })

    // The headless lane decides again inside createTerminal; it must see the phone's default.
    expect(spawn.mock.calls[0]?.[0]).not.toHaveProperty('startingViewMode')
    expect(result.tab.viewMode).toBeUndefined()
    expect(
      getSession().tabsByWorktree[WT]?.find((tab) => tab.id === result.tab.parentTabId)?.viewMode
    ).toBeUndefined()
  })

  it("session.tabs.createTerminal stamps a phone's chat default over a terminal host", async () => {
    const { runtime, getSession } = harness({ settings: TERMINAL_DEFAULT })

    const result = await runtime.createMobileSessionTerminal(`id:${WT}`, {
      agent: 'claude',
      launcherDefaultView: 'chat'
    })

    expect(result.tab).toMatchObject({
      viewMode: 'chat',
      parentLayout: { chatLeafId: result.tab.leafId }
    })
    expect(
      getSession().tabsByWorktree[WT]?.find((tab) => tab.id === result.tab.parentTabId)?.viewMode
    ).toBe('chat')
  })
})

describe('preservation', () => {
  it('a plain shell gets no starting view', async () => {
    const { runtime, spawn, published } = harness({ settings: CHAT_DEFAULT })

    const created = await runtime.createTerminal(`id:${WT}`, {
      command: 'bash',
      presentation: 'background'
    })

    expect(spawn.mock.calls[0]?.[0]).not.toHaveProperty('startingViewMode')
    expect(published(created.tabId!)?.viewMode).toBeUndefined()
  })

  it('a launch into an existing unswitched tab keeps it unswitched after the default became chat', async () => {
    const revealTerminalSession = vi.fn(
      async (_worktreeId: string, _opts: Record<string, unknown>) => ({
        tabId: EXISTING_TAB,
        title: ''
      })
    )
    const { runtime, getSession, published } = harness({
      settings: CHAT_DEFAULT,
      session: sessionWithExistingUnswitchedTab(),
      revealTerminalSession
    })

    await runtime.createTerminal(`id:${WT}`, {
      startupAgent: 'claude',
      tabId: EXISTING_TAB,
      leafId: NEW_LEAF
    })

    expect(
      getSession().tabsByWorktree[WT]?.find((tab) => tab.id === EXISTING_TAB)?.viewMode
    ).toBeUndefined()
    expect(published(EXISTING_TAB)?.viewMode).toBeUndefined()
    const reveal: Record<string, unknown> | undefined = revealTerminalSession.mock.calls[0]?.[1]
    expect(reveal).not.toHaveProperty('viewMode')
    expect(reveal).not.toHaveProperty('freshLaunchView')
  })

  it('F2: a fresh host-stamped chat launch is not read as an agent exit', async () => {
    const { runtime, internal, getSession, published, spawn } = harness({ settings: CHAT_DEFAULT })
    const created = await runtime.createTerminal(`id:${WT}`, {
      startupAgent: 'claude',
      presentation: 'background'
    })
    const leafId = spawn.mock.calls[0]![0].leafId

    // A title change / finished shell command, and a removed owner row, before any agent run.
    internal.nudgeAgentExitCheck(created.ptyId!)
    internal.noteAgentOwnerPresenceChange({ paneKey: `${created.tabId}:${leafId}`, presence: null })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(getSession().tabsByWorktree[WT]?.find((tab) => tab.id === created.tabId)).toMatchObject({
      viewMode: 'chat'
    })
    expect(published(created.tabId!)?.viewMode).toBe('chat')
  })
})
