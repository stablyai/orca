import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../orca-runtime'
import { getDefaultWorkspaceSession } from '../../../shared/constants'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { listAvailableWorkerTerminals } from './coordinator-task-dispatch'
import type { OrchestrationDb } from './db'

// Coercion site 4 repro at the orchestration level: a live worker terminal whose
// pane misses one inventory snapshot while the per-id presence query answers
// `null` (unanswerable) must stay dispatchable. Pre-fix the `null` was read as
// proven absence, the summary demoted to connected:false, and the coordinator
// wrote the worker terminal off.

const WORKTREE_ID = 'repo-1::/tmp/probe-worktree'
const LEAF_ID = '11111111-1111-4111-8111-111111111111'

function makeStore() {
  const session: WorkspaceSessionState = getDefaultWorkspaceSession()
  return {
    getWorkspaceSession: vi.fn(() => session),
    setWorkspaceSession: vi.fn(),
    getRepos: vi.fn(() => [
      {
        id: 'repo-1',
        path: '/tmp/probe-worktree',
        displayName: 'probe',
        badgeColor: '#000000',
        addedAt: 0
      }
    ]),
    getAllWorktreeMeta: vi.fn(() => ({})),
    getWorktreeMeta: vi.fn(() => undefined),
    setWorktreeMeta: vi.fn(),
    getSettings: vi.fn(() => ({ workspaceDir: '/tmp/workspaces' })),
    getProjects: vi.fn(() => [])
  }
}

function makeRuntimeWithLeaf(options: {
  leafPtyId: string
  controllerSessions: { id: string; cwd: string }[]
  hasPty: (ptyId: string) => boolean | null
}): OrcaRuntimeService {
  const runtime = new OrcaRuntimeService(makeStore() as never)
  runtime.setPtyController({
    spawn: vi.fn(async () => ({ id: 'never' })),
    write: () => true,
    kill: () => true,
    hasPty: options.hasPty,
    listProcesses: vi.fn(async () => options.controllerSessions)
  } as never)
  runtime.attachWindow(1)
  runtime.syncWindowGraph(1, {
    tabs: [
      {
        tabId: 'tab-1',
        worktreeId: WORKTREE_ID,
        title: '',
        activeLeafId: LEAF_ID,
        layout: null
      }
    ],
    leaves: [
      {
        tabId: 'tab-1',
        worktreeId: WORKTREE_ID,
        leafId: LEAF_ID,
        paneRuntimeId: 1,
        ptyId: options.leafPtyId,
        paneTitle: null,
        title: ''
      }
    ]
  })
  return runtime
}

const idleDb = {
  listTasks: vi.fn(() => []),
  getDispatchContext: vi.fn(() => undefined)
} as unknown as OrchestrationDb

describe('listAvailableWorkerTerminals liveness truth', () => {
  it('keeps a worker terminal dispatchable when its presence query cannot answer', async () => {
    const runtime = makeRuntimeWithLeaf({
      leafPtyId: 'pty-worker-unqueryable',
      controllerSessions: [],
      hasPty: () => null
    })
    const { terminals } = await runtime.listTerminals(`id:${WORKTREE_ID}`)
    expect(terminals).toHaveLength(1)

    const available = await listAvailableWorkerTerminals(
      idleDb,
      runtime,
      'term_coordinator-elsewhere',
      `id:${WORKTREE_ID}`
    )

    expect(available).toEqual([terminals[0].handle])
  })

  it('still excludes a worker terminal whose absence the controller confirmed', async () => {
    const runtime = makeRuntimeWithLeaf({
      leafPtyId: 'pty-worker-exited',
      controllerSessions: [],
      hasPty: () => false
    })

    const available = await listAvailableWorkerTerminals(
      idleDb,
      runtime,
      'term_coordinator-elsewhere',
      `id:${WORKTREE_ID}`
    )

    expect(available).toEqual([])
  })
})
