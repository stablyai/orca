import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { getDefaultWorkspaceSession } from '../../../../shared/orca-profiles/constants'
import { makePaneKey } from '../../../../shared/workspace-layout/stable-pane-id'
import { AgentHookServer } from '../../../agent-hooks/server/agent-hook-server'
import { OrcaRuntimeService } from '../../orca-runtime'
import { captureWorktreeSleepResumeRecords } from '../../terminal/stop/worktree-sleep-resume-records'
import {
  partialRuntimeStore,
  storeFolderWorkspace,
  storeProjectGroup
} from '../../construction/test-context/runtime-store-partial-fixture'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn(), emit: vi.fn(() => true) },
  app: { getPath: vi.fn(() => '/tmp'), isPackaged: false }
}))
vi.mock('../../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../../telemetry/cohort-classifier', () => ({ getCohortAtEmit: () => ({}) }))

const WORKTREE = 'folder:saved-sleep'
const TAB = 'tab-saved-sleep'
const PANE = makePaneKey(TAB, '11111111-1111-4111-8111-111111111111')
const servers: AgentHookServer[] = []
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(1_000)
})
afterEach(() => {
  vi.useRealTimers()
  for (const server of servers.splice(0)) {
    server.stop()
  }
})

it.each(['claude', 'codex'] as const)(
  'lists a slept %s from its saved record after every volatile row is evicted',
  async (agent) => {
    const session = getDefaultWorkspaceSession()
    session.tabsByWorktree[WORKTREE] = [
      {
        id: TAB,
        worktreeId: WORKTREE,
        ptyId: null,
        title: 'Terminal',
        customTitle: null,
        color: null,
        sortOrder: 0,
        createdAt: 100
      }
    ]
    const server = new AgentHookServer()
    servers.push(server)
    server.setTerminalPaneLifecycle({
      readSavedRecord: (paneKey) => session.sleepingAgentSessionsByPaneKey?.[paneKey],
      retireSavedRecord: (paneKey) => {
        const saved = session.sleepingAgentSessionsByPaneKey?.[paneKey]
        delete session.sleepingAgentSessionsByPaneKey?.[paneKey]
        return saved
      },
      ownsProcess: () => true,
      isStopping: () => false,
      isReversibleStop: () => true,
      isPlaced: () => true,
      confirmShellAlone: async () => true
    })
    server.ingestRemote(
      {
        paneKey: PANE,
        tabId: TAB,
        worktreeId: WORKTREE,
        source: agent,
        hookEventName: 'UserPromptSubmit',
        hasExplicitPrompt: true,
        providerSession: { key: 'session_id', id: `${agent}-conversation` },
        payload: { agentType: agent, state: 'working', prompt: 'Finish this task' }
      },
      null
    )
    const capture = await captureWorktreeSleepResumeRecords({
      worktreeId: WORKTREE,
      paneKeysByPtyId: new Map([['pty', [PANE]]]),
      launchByPtyId: new Map(),
      readRowsForPane: (paneKey) => server.getStatusSnapshotForPane(paneKey),
      readIdentity: (paneKey) => server.paneAgentIdentity(paneKey),
      checkAgentPresence: null,
      capturedAt: 1_000
    })
    session.sleepingAgentSessionsByPaneKey = Object.fromEntries(
      capture.get('pty')!.records.map((record) => [record.paneKey, record])
    )
    expect(server.settleTerminalPaneSleep(PANE, 'pty', 'birth')).toBe(true)
    server.dropStatusEntry(PANE, { preserveResumeIdentity: false })
    expect(server.getStatusSnapshotForPane(PANE)).toEqual([])

    const runtime = new OrcaRuntimeService(
      partialRuntimeStore({
        getWorkspaceSession: () => session,
        getFolderWorkspaces: () => [
          storeFolderWorkspace({
            id: 'saved-sleep',
            projectGroupId: 'group',
            folderPath: '/tmp/saved-sleep'
          })
        ],
        getProjectGroups: () => [storeProjectGroup({ id: 'group' })]
      }),
      undefined,
      {
        getPaneAgentIdentity: (paneKey, saved) => server.paneAgentIdentity(paneKey, saved),
        getAgentProviderSessionSnapshot: () => server.getStatusSnapshot()
      }
    )
    const listed = async () =>
      (await runtime.getWorktreePs(100, true, true)).worktrees.find(
        (row) => row.worktreeId === WORKTREE
      )
    const row = await listed()
    expect(row).toMatchObject({
      liveTerminalCount: 0,
      agents: [
        {
          paneKey: PANE,
          agentType: agent,
          state: 'done',
          interrupted: true,
          prompt: 'Finish this task'
        }
      ]
    })
    expect(row?.agents[0]?.hasLivePty).toBeUndefined()
    expect(row?.agents[0]?.agentWait).toBeUndefined()

    server.retireProcessAuthority(PANE, { confirmedExit: true })
    await vi.waitFor(async () => expect((await listed())?.agents).toEqual([]))
  }
)

it('lists no agent from a live checkpoint alone, which is recovery, not a running agent', async () => {
  const session = getDefaultWorkspaceSession()
  session.tabsByWorktree[WORKTREE] = [
    {
      id: TAB,
      worktreeId: WORKTREE,
      ptyId: null,
      title: 'Terminal',
      customTitle: null,
      color: null,
      sortOrder: 0,
      createdAt: 100
    }
  ]
  session.sleepingAgentSessionsByPaneKey = {
    [PANE]: {
      paneKey: PANE,
      tabId: TAB,
      worktreeId: WORKTREE,
      agent: 'codex',
      providerSession: { key: 'session_id', id: 'checkpointed-codex' },
      prompt: 'Finish this task',
      state: 'working',
      capturedAt: 900,
      updatedAt: 900,
      origin: 'live'
    }
  }
  const server = new AgentHookServer()
  servers.push(server)
  const runtime = new OrcaRuntimeService(
    partialRuntimeStore({
      getWorkspaceSession: () => session,
      getFolderWorkspaces: () => [
        storeFolderWorkspace({
          id: 'saved-sleep',
          projectGroupId: 'group',
          folderPath: '/tmp/saved-sleep'
        })
      ],
      getProjectGroups: () => [storeProjectGroup({ id: 'group' })]
    }),
    undefined,
    {
      getPaneAgentIdentity: (paneKey, saved) => server.paneAgentIdentity(paneKey, saved),
      getAgentProviderSessionSnapshot: () => server.getStatusSnapshot()
    }
  )
  const row = (await runtime.getWorktreePs(100, true, true)).worktrees.find(
    (worktree) => worktree.worktreeId === WORKTREE
  )
  expect(row?.agents).toEqual([])
})
