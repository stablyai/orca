import { describe, expect, it, vi } from 'vitest'

const { ipcHandlers } = vi.hoisted(() => ({
  ipcHandlers: new Map<string, (...args: unknown[]) => unknown>()
}))

// Why the partial mock: `ipcMain` is undefined outside an Electron process, and the
// snapshot-pull producer only exists as an `ipcMain.handle` body. Everything else stays real.
vi.mock('electron', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) =>
      ipcHandlers.set(channel, handler),
    removeHandler: () => {},
    on: () => {},
    removeAllListeners: () => {}
  }
}))
const { listWorktreesStrict } = vi.hoisted(() => ({ listWorktreesStrict: vi.fn() }))
// The git binary is the external boundary for worktree.ps; everything above it stays real.
vi.mock('../../../../../git/worktree', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  listWorktreesStrict,
  listWorktreesFromMembershipStrict: listWorktreesStrict
}))
// The push path reaches the dashboard popout window, whose electron re-export cannot load here.
vi.mock('@electron-toolkit/utils', () => ({
  is: { dev: false },
  optimizer: { watchWindowShortcuts: vi.fn() },
  electronApp: { setAppUserModelId: vi.fn() }
}))

import type Database from '../../../../../sqlite/sync-database'
import type { AgentStatusIpcPayload } from '../../../../../../shared/agent-status-ipc-payload'
import { toAgentStatusIpcPayload } from '../../../../../agent-hooks/server/server-status-identity'
import type { EnrichedAgentHookEventPayload } from '../../../../../agent-hooks/server/server-types'
import { registerAgentHookHandlers } from '../../../../../ipc/agent-hooks'
import { installMainWindowAgentStatusListeners } from '../../../../../startup/main-window-agent-status'
import { mainProcessState } from '../../../../../startup/main-process-state'
import { agentHookServer } from '../../../../../agent-hooks/server'
import { OrchestrationDb } from '../../../../orchestration/db'
import { OrcaRuntimeService } from '../../../../orca-runtime'
import { ORCHESTRATION_WORKER_LIST_METHOD } from './worker-list-method'
import { projectFleetWorkerPage } from './worker-observation'

const PANE_KEY = 'tab-census:leaf-census'
const TERMINAL_HANDLE = 'term_census'
const PROCESS_INCARNATION = 'pty-census:inc-1'
const DISPATCH_ID = 'dispatch-census'
const WORKTREE_ID = 'wt-census'

/** Exactly the entry the hook server holds; `toAgentStatusIpcPayload` is what it publishes. */
function hookEntry(): EnrichedAgentHookEventPayload {
  const observedAt = Date.now() - 1_000
  return {
    paneKey: PANE_KEY,
    tabId: 'tab-census',
    worktreeId: WORKTREE_ID,
    connectionId: null,
    receivedAt: observedAt,
    stateStartedAt: observedAt,
    payload: { state: 'working', agentType: 'claude' }
  } as unknown as EnrichedAgentHookEventPayload
}

function publishedHookRow(): AgentStatusIpcPayload {
  return toAgentStatusIpcPayload(hookEntry())
}

/** A runtime whose only stubs are the pane-to-terminal lookups the real terminal registry owns. */
function censusRuntime(): OrcaRuntimeService {
  const runtime = new OrcaRuntimeService(null, undefined, {
    getAgentStatusSnapshot: () => [publishedHookRow()]
  })
  vi.spyOn(runtime, 'getAgentStatusTerminalHandleForPaneKey').mockImplementation((paneKey) =>
    paneKey === PANE_KEY ? TERMINAL_HANDLE : undefined
  )
  vi.spyOn(runtime, 'getAgentStatusOrchestrationContextForPaneKey').mockReturnValue(undefined)
  // The incarnation is the third fact the real terminal registry owns for a bound pane; the
  // census seeds no resource row, so no durable incarnation contradicts it.
  vi.spyOn(runtime, 'getTerminalProcessIncarnation').mockImplementation((handle) =>
    handle === TERMINAL_HANDLE ? PROCESS_INCARNATION : null
  )
  return runtime
}

function seedWorker(db: OrchestrationDb): void {
  const run = db.createRun({
    objective: 'Producer census',
    coordinatorHandle: 'term-coordinator',
    coordinatorPaneKey: 'tab-coordinator:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  })
  const task = db.createTask({ spec: 'census worker', runId: run.id })
  const sqlite = (db as unknown as { db: Database.Database }).db
  sqlite
    .prepare(
      `INSERT INTO dispatch_contexts (
         id, run_id, task_id, assignee_handle, assignee_pane_key, status, created_at
       ) VALUES (?, ?, ?, ?, ?, 'dispatched', '2026-08-27 00:00:00')`
    )
    .run(DISPATCH_ID, run.id, task.id, TERMINAL_HANDLE, PANE_KEY)
  sqlite
    .prepare(
      `INSERT INTO worker_dispatches (
         dispatch_id, state, stage, agent_terminal_handle, worktree_id
       ) VALUES (?, 'ready', 'input_accepted', ?, ?)`
    )
    .run(DISPATCH_ID, TERMINAL_HANDLE, WORKTREE_ID)
}

const REPO_PATH = '/census/repo'

/** Enough store for `worktree.ps` to resolve one worktree; the git listing is mocked above. */
function censusStore() {
  const metaById: Record<string, unknown> = {}
  return {
    getRepo: (id: string) => (id === 'repo-census' ? censusStore().getRepos()[0] : undefined),
    getRepos: () => [
      { id: 'repo-census', path: REPO_PATH, displayName: 'census', badgeColor: 'blue', addedAt: 1 }
    ],
    getAllWorktreeMeta: () => metaById,
    getWorktreeMeta: (id: string) => metaById[id],
    setWorktreeMeta: (id: string, meta: Record<string, unknown>) => {
      metaById[id] = { ...(metaById[id] as object), ...meta }
      return metaById[id]
    },
    removeWorktreeMeta: () => {},
    getAllWorktreeLineage: () => ({}),
    getAllWorkspaceLineage: () => ({}),
    removeWorktreeLineage: vi.fn(),
    removeWorkspaceLineage: vi.fn(),
    getGitHubCache: () => undefined as never,
    getSettings: () => ({
      workspaceDir: '/census/workspaces',
      nestWorkspaces: false,
      refreshLocalBaseRefOnWorktreeCreate: false,
      branchPrefix: 'none',
      branchPrefixCustom: ''
    }),
    getProjects: () => []
  }
}

describe('agent status identity across every producer and consumer path', () => {
  it('reads live on worker-list from a hook row that carries only a pane key', async () => {
    const db = new OrchestrationDb(':memory:')
    try {
      seedWorker(db)
      const runtime = censusRuntime()
      runtime.setOrchestrationDb(db)

      const params = ORCHESTRATION_WORKER_LIST_METHOD.params?.parse({})
      const page = (await ORCHESTRATION_WORKER_LIST_METHOD.handler(params, { runtime })) as {
        workers: { dispatchId: string; projection: { liveness: { verdict: string } } }[]
      }

      expect(page.workers.map((worker) => worker.dispatchId)).toEqual([DISPATCH_ID])
      expect(page.workers[0]?.projection.liveness).toMatchObject({
        verdict: 'live',
        source: 'agent_status'
      })
    } finally {
      db.close()
    }
  })

  it('reads live on worker-show from a hook row that carries only a pane key', () => {
    const db = new OrchestrationDb(':memory:')
    try {
      seedWorker(db)
      const runtime = censusRuntime()
      runtime.setOrchestrationDb(db)

      const page = projectFleetWorkerPage(runtime, db, DISPATCH_ID)

      expect(page?.workers[0]?.liveness).toMatchObject({
        verdict: 'live',
        source: 'agent_status'
      })
    } finally {
      db.close()
    }
  })

  it('attaches terminal identity on the renderer snapshot pull', async () => {
    const runtime = censusRuntime()
    vi.spyOn(agentHookServer, 'getStatusSnapshot').mockReturnValue([publishedHookRow()])
    registerAgentHookHandlers(runtime, {})

    const handler = ipcHandlers.get('agentStatus:getSnapshot')
    const rows = (await handler?.()) as AgentStatusIpcPayload[]

    expect(publishedHookRow().terminalHandle).toBeUndefined()
    expect(rows[0]).toMatchObject({ paneKey: PANE_KEY, terminalHandle: TERMINAL_HANDLE })
  })

  it('lists a worktree.ps agent row from a hook row that carries only a pane key', async () => {
    listWorktreesStrict.mockResolvedValue([
      { path: REPO_PATH, head: 'abc', branch: 'main', isBare: false, isMainWorktree: true }
    ])
    // The hook row names its worktree by id, so learn the id the runtime minted before publishing.
    let rows: AgentStatusIpcPayload[] = []
    const runtime = new OrcaRuntimeService(censusStore() as never, undefined, {
      getAgentStatusSnapshot: () => rows
    })

    const discovery = await runtime.getWorktreePs(10)
    const worktreeId = discovery.worktrees[0]?.worktreeId
    expect(worktreeId).toEqual(expect.any(String))
    rows = [
      toAgentStatusIpcPayload({
        ...hookEntry(),
        worktreeId,
        // A remote hook row; the local variant is gated on live pty evidence, not on identity.
        connectionId: 'ssh-census'
      } as unknown as EnrichedAgentHookEventPayload)
    ]

    const page = await runtime.getWorktreePs(10)

    expect(rows[0]?.terminalHandle).toBeUndefined()
    expect(page.worktrees[0]?.agents).toEqual([
      expect.objectContaining({ paneKey: PANE_KEY, state: 'working' })
    ])
  })

  it('attaches terminal identity on the renderer live push', () => {
    const runtime = censusRuntime()
    const sent: { channel: string; payload: AgentStatusIpcPayload }[] = []
    const listeners: ((entry: EnrichedAgentHookEventPayload) => void)[] = []
    vi.spyOn(agentHookServer, 'setListener').mockImplementation(((
      listener: (entry: EnrichedAgentHookEventPayload) => void
    ) => {
      listeners.push(listener)
    }) as never)
    const window = {
      isDestroyed: () => false,
      webContents: {
        send: (channel: string, payload: AgentStatusIpcPayload) => sent.push({ channel, payload })
      }
    }
    const previousWindow = mainProcessState.mainWindow
    const previousRuntime = mainProcessState.runtime
    mainProcessState.mainWindow = window as never
    mainProcessState.runtime = runtime
    try {
      installMainWindowAgentStatusListeners({
        window: window as never,
        maybeAutoRenameBranchOnFirstWork: () => {},
        onRecordAgentState: () => {}
      })
      for (const listener of listeners) {
        listener(hookEntry())
      }
    } finally {
      mainProcessState.mainWindow = previousWindow
      mainProcessState.runtime = previousRuntime
    }

    expect(sent.map((event) => event.channel)).toContain('agentStatus:set')
    expect(sent[0]?.payload).toMatchObject({ paneKey: PANE_KEY, terminalHandle: TERMINAL_HANDLE })
  })
})
