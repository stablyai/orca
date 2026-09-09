import { resolve } from 'node:path'
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
  listWorktreesStrict
}))
// The push path reaches the dashboard popout window, whose electron re-export cannot load here.
vi.mock('@electron-toolkit/utils', () => ({
  is: { dev: false },
  optimizer: { watchWindowShortcuts: vi.fn() },
  electronApp: { setAppUserModelId: vi.fn() }
}))

import type Database from '../../../../../sqlite/sync-database'
import {
  scanSourceTree,
  stripComments
} from '../../../../../../shared/source-scan/source-tree-scan'
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

/**
 * Census of every production site in `src/main` that turns hook-server agent-status rows into
 * something a consumer reads.
 *
 * Why a census and not a single seam test: the false-liveness bug (rework failure table L-1) was
 * one such site publishing rows that carry a pane key and nothing else, into a consumer that
 * matches on terminal identity. Fixing that site fixes nothing if a fifth one is added beside it,
 * so the list is pinned and the identity-bearing paths are each driven end to end.
 */
type CensusRow = {
  path: string
  /** `produces` = mints payloads a consumer reads; `consumes` = reads them; `wiring` = neither. */
  kind: 'produces' | 'consumes' | 'wiring'
  role: string
}

const CENSUS: readonly CensusRow[] = [
  {
    path: 'main/ipc/agent-hooks.ts',
    kind: 'produces',
    role: 'agentStatus:getSnapshot — renderer pull, enriched (driven below)'
  },
  {
    path: 'main/ipc/agent-status-ipc-boundary.ts',
    kind: 'produces',
    role: 'resolveAgentStatusBinding — the one identity lookup the pull and fleet paths share'
  },
  {
    path: 'main/runtime/agent-status-observed-pane-identity.ts',
    kind: 'produces',
    role: 'captures the identity a hook row was observed under (fleet-status-observed-identity)'
  },
  {
    path: 'main/runtime/orchestration-fleet-agent-status-snapshot.ts',
    kind: 'produces',
    role: 'readOrchestrationFleetAgentStatusSnapshot — the minted fleet evidence (driven below)'
  },
  {
    path: 'main/startup/main-window-agent-status.ts',
    kind: 'produces',
    role: 'agentStatus:set — renderer live push, enriched inline (driven below)'
  },
  {
    path: 'main/startup/main-process-runtime-service.ts',
    kind: 'wiring',
    role: 'binds the hook server snapshot into the runtime deps'
  },
  {
    path: 'main/runtime/orca-runtime-state-fields.ts',
    kind: 'wiring',
    role: 'stores the snapshot deps on the runtime'
  },
  {
    path: 'main/runtime/orca-runtime-preserved-branch-cleanup.ts',
    kind: 'wiring',
    role: 'declares the snapshot dep fields'
  },
  {
    path: 'main/runtime/orca-runtime-get-orchestration-dispatch-authority.ts',
    kind: 'produces',
    role: 'getOrchestrationFleetAgentStatusSnapshot — delegates to the checked snapshot module'
  },
  {
    path: 'main/runtime/orca-runtime-stop-requested-pty-ids.ts',
    kind: 'wiring',
    role: 'feeds the enriched fleet rows to the orchestration projection'
  },
  {
    path: 'main/runtime/runtime-agent-orchestration-projection.ts',
    kind: 'consumes',
    role: 'indexes rows by pane key to attach dispatch context'
  },
  {
    path: 'main/runtime/rpc/methods/orchestration/worker/worker-list-method.ts',
    kind: 'consumes',
    role: 'worker-list fleet verdict (driven below)'
  },
  {
    path: 'main/runtime/rpc/methods/orchestration/worker/worker-observation.ts',
    kind: 'consumes',
    role: 'worker-show fleet verdict (driven below)'
  },
  {
    path: 'main/runtime/orca-runtime-get-worktree-ps.ts',
    kind: 'consumes',
    role: 'worktree.ps inline agent rows (driven below)'
  },
  {
    path: 'main/runtime/orca-runtime-get-terminal-interactive-wait.ts',
    kind: 'consumes',
    role: 'exact-worker provider session selection, matched on pane key'
  },
  {
    path: 'main/runtime/orca-runtime-serialize-agent-prompt-submission.ts',
    kind: 'consumes',
    role: 'prompt-submission serialization, matched on pane key'
  },
  {
    path: 'main/runtime/orca-runtime-resolve-recovered-structured-tui-transcript.ts',
    kind: 'consumes',
    role: 'recovered transcript resolution from provider-session rows, matched on pane key'
  },
  {
    path: 'main/runtime/orca-runtime-prune-mobile-session-tab-group-layout.ts',
    kind: 'consumes',
    role: 'mobile tab-group pruning from provider-session rows, and the pane identity accessors'
  }
]

/** The names a hook row travels under. A new producer has to use one of them to reach a consumer. */
const PRODUCER_TOKENS =
  /getAgentStatusSnapshot|getAgentProviderSessionSnapshot|enrichAgentStatusIpcPayload|mintAgentStatusFleetEvidence|resolveAgentStatusBinding|getOrchestrationFleetAgentStatusSnapshot|agentStatus:set/

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

describe('agent status producer census', () => {
  it('pins every production site that hands hook rows to a consumer', () => {
    const root = resolve(import.meta.dirname, '../../../../../..')
    const scanned = scanSourceTree(resolve(root, 'main'))
      .filter((file) => PRODUCER_TOKENS.test(stripComments(file.source)))
      .map((file) => `main/${file.relativePath}`)
      .sort()

    expect(scanned).toEqual(CENSUS.map((row) => row.path).sort())
  })

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
