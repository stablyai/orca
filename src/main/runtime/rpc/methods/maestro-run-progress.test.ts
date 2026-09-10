import { describe, expect, it, vi } from 'vitest'
import type { FolderWorkspace } from '../../../../shared/folder-workspace-types'
import type { AgentGraphView, MaestroWorkspaceAnchor } from '../../../../shared/maestro-contract'
import {
  MAESTRO_RUN_COMPLETION_RUNTIME_CAPABILITY,
  MAESTRO_RUN_PROGRESS_V2_RUNTIME_CAPABILITY
} from '../../../../shared/protocol-version'
import { OrchestrationDb } from '../../orchestration/db/orchestration-db'
import { createRootDispatch } from '../../orchestration/db/root-dispatch-test-fixture'
import { applyMaestroProjection } from '../../orchestration/db/maestro/maestro-projection-store'
import type { RpcContext } from '../core'
import { ALL_RPC_METHODS } from './index'
import { MAESTRO_RUN_PROGRESS_METHODS, readMaestroRunProgress } from './maestro-run-progress'

const folder: FolderWorkspace = {
  id: 'home-1',
  projectGroupId: 'group-1',
  name: 'Home',
  folderPath: '/workspace/home',
  linkedTask: null,
  comment: '',
  isArchived: false,
  isUnread: false,
  isPinned: false,
  sortOrder: 0,
  lastActivityAt: 0,
  createdAt: 0,
  updatedAt: 0
}

function seed() {
  const database = new OrchestrationDb(':memory:')
  const run = database.createRun({
    objective: 'Project human Run progress',
    coordinatorHandle: 'coordinator-1',
    coordinatorPaneKey: 'tab-1:leaf-1'
  })
  const task = database.createTask({
    runId: run.id,
    taskTitle: 'Implement projector',
    displayName: 'Progress worker',
    spec: 'Implement the runtime-owned projector.'
  })
  const workspace: MaestroWorkspaceAnchor = {
    repository_id: 'folder-workspace-group-1',
    execution_host_id: 'local',
    workspace_key: 'folder:home-1',
    run_id: run.id
  }
  const view: AgentGraphView = {
    schema_version: 1,
    protocol: 'agent-graph-view/v1',
    kind: 'snapshot',
    workspace_scope: {
      schema_version: 1,
      repository_id: workspace.repository_id,
      canonical_root: '/workspace/home',
      execution_host: { id: 'local', boundary: 'local' },
      orchestration_home: {
        execution_host_id: 'local',
        workspace_key: 'folder:home-1',
        kind: 'folder',
        path: '/workspace/home'
      },
      execution_workspace: {
        execution_host_id: 'local',
        workspace_key: 'folder:home-1',
        kind: 'folder',
        path: '/workspace/home'
      },
      base_revision: 'folder-observation:one',
      dirty_paths: [],
      run_id: run.id,
      coordinator_generation: 1,
      binding_receipt_ref: 'artifact:bootstrap.json',
      binding_receipt_hash: `sha256:${'a'.repeat(64)}`
    },
    change: 'orchestration-run',
    run_id: run.id,
    coordinator: { id: 'coordinator-1', generation: 1 },
    capabilities: {
      agents: ['codex'],
      efforts: ['high'],
      placement_kinds: ['current-workspace'],
      watch_deltas: true
    },
    nodes: [],
    edges: [],
    removed_node_ids: [],
    removed_edge_ids: [],
    revision: 4,
    cursor: null,
    from_cursor: null,
    reset_required: false,
    progress: undefined
  }
  applyMaestroProjection.call(database, workspace, view)
  return { database, run, task, view }
}

function context(
  database: OrchestrationDb,
  capabilities?: RpcContext['clientCapabilities']
): RpcContext {
  return {
    runtime: {
      getOrchestrationDb: () => database,
      listFolderWorkspaces: () => [folder],
      listRepos: () => [],
      getExactWorkerProviderSession: vi.fn(() => null),
      showTerminal: vi.fn().mockRejectedValue(new Error('terminal unavailable')),
      getTerminalPaneKey: vi.fn(() => null),
      getTerminalProcessIncarnation: vi.fn(() => null),
      getTerminalLivenessVerdict: vi.fn(() => null)
    } as unknown as RpcContext['runtime'],
    clientCapabilities: capabilities
  }
}

describe('Maestro Run progress RPC', () => {
  it('registers a bounded read method', () => {
    expect(MAESTRO_RUN_PROGRESS_METHODS.map(({ name }) => name)).toEqual([
      'maestro.runProgress.get'
    ])
    expect(ALL_RPC_METHODS.some(({ name }) => name === 'maestro.runProgress.get')).toBe(true)
  })

  it('returns runtime-owned v2 progress to a capable client', async () => {
    const { database, run } = seed()
    const response = await readMaestroRunProgress(
      context(database, [MAESTRO_RUN_PROGRESS_V2_RUNTIME_CAPABILITY]),
      { execution_host_id: 'local', workspace_key: 'folder:home-1' }
    )

    expect(response).toMatchObject({
      schemaVersion: 2,
      documentRevision: null,
      selectedRunId: run.id,
      projectionRevisions: [{ runId: run.id, revision: 4 }],
      projectionHealth: { state: 'healthy', revision: 4 },
      progress: {
        schema_version: 2,
        run: { id: run.id, title: 'Project human Run progress' },
        execution: { total: 1, completed: 0, progress_percent: 0 },
        projection_health: { state: 'healthy', revision: 4 },
        resources: expect.arrayContaining([
          expect.objectContaining({
            kind: 'coordinator',
            state: 'unverifiable'
          })
        ])
      }
    })
    database.close()
  })

  it('keeps the v1 projection readable for an older client', async () => {
    const { database } = seed()
    const response = await readMaestroRunProgress(context(database, []), {
      execution_host_id: 'local',
      workspace_key: 'folder:home-1'
    })

    expect(response).toEqual({
      schemaVersion: 1,
      progress: { available: false, state: 'outcome_unknown' }
    })
    database.close()
  })

  it('publishes completion only to v2 clients that advertise the additive field', async () => {
    const { database, run, task } = seed()
    database.completeRun({
      runId: run.id,
      summary: 'Accepted with one explicit waiver.',
      evidence: ['Focused checks passed.'],
      waivers: [{ task_id: task.id, reason: 'The owner deferred this Task.' }],
      coordinatorHandle: run.coordinator_handle!,
      coordinatorPaneKey: run.coordinator_pane_key!,
      coordinatorGeneration: run.consumer_generation
    })
    const scope = { execution_host_id: 'local', workspace_key: 'folder:home-1' } as const

    const olderV2 = await readMaestroRunProgress(
      context(database, [MAESTRO_RUN_PROGRESS_V2_RUNTIME_CAPABILITY]),
      scope
    )
    const completionCapable = await readMaestroRunProgress(
      context(database, [
        MAESTRO_RUN_PROGRESS_V2_RUNTIME_CAPABILITY,
        MAESTRO_RUN_COMPLETION_RUNTIME_CAPABILITY
      ]),
      scope
    )

    if (olderV2.schemaVersion !== 2) {
      throw new Error(`Expected v2 progress, received ${olderV2.schemaVersion ?? 'none'}.`)
    }
    expect(olderV2.progress.completion).toBeUndefined()
    expect(completionCapable).toMatchObject({
      schemaVersion: 2,
      progress: {
        completion: {
          state: 'completed',
          summary: 'Accepted with one explicit waiver.',
          completed_by: { handle: 'coordinator-1', generation: run.consumer_generation }
        }
      }
    })
    database.close()
  })

  it('treats SQLite dispatch timestamps as UTC when selecting native child activity', async () => {
    const { database, task } = seed()
    const dispatch = createRootDispatch(database, task.id, 'worker-1', 'tab-2:leaf-1')
    database.db
      .prepare('UPDATE dispatch_contexts SET dispatched_at = ? WHERE id = ?')
      .run('2026-08-29 01:02:03', dispatch.id)
    const rpcContext = context(database, [MAESTRO_RUN_PROGRESS_V2_RUNTIME_CAPABILITY])

    await readMaestroRunProgress(rpcContext, {
      execution_host_id: 'local',
      workspace_key: 'folder:home-1'
    })

    expect(rpcContext.runtime.getExactWorkerProviderSession).toHaveBeenCalledWith(
      'worker-1',
      Date.parse('2026-08-29T01:02:03Z')
    )
    database.close()
  })

  it('reports cleanup uncertainty from a worker execution workspace', async () => {
    const { database, run, task } = seed()
    const lease = database.reserveMaestroTerminalLease({
      requestId: 'request-remote',
      executionHostId: 'ssh:worker-host',
      workspaceKey: 'worktree:remote-worker',
      runId: run.id,
      taskId: task.id,
      attemptId: 'attempt-remote',
      role: 'worker',
      title: 'Remote worker',
      launchProfile: {
        agent: 'codex',
        model: 'gpt-5.6-sol',
        effort: 'high',
        permissionMode: 'default',
        routeRef: null
      },
      spawnedBy: 'coordinator-1',
      ownerPrincipal: 'dispatch:remote',
      retentionPolicy: 'auto_release'
    })
    database.db
      .prepare(
        "UPDATE maestro_terminal_leases SET lifecycle_state = 'outcome_unknown' WHERE id = ?"
      )
      .run(lease.id)

    const response = await readMaestroRunProgress(
      context(database, [MAESTRO_RUN_PROGRESS_V2_RUNTIME_CAPABILITY]),
      { execution_host_id: 'local', workspace_key: 'folder:home-1' }
    )

    if (response.schemaVersion !== 2) {
      throw new Error(`Expected v2 progress, received ${response.schemaVersion ?? 'none'}.`)
    }
    expect(response.progress.cleanup_health).toMatchObject({ state: 'unverifiable', count: 1 })
    expect(response.progress.resources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'terminal',
          reference: lease.id,
          parent_reference: 'attempt-remote',
          activation_reference: task.id,
          state: 'unverifiable'
        })
      ])
    )
    database.close()
  })

  it('recovers an exact folder Run through the authenticated current-generation lease', async () => {
    const { database, run } = seed()
    database.db
      .prepare(
        `UPDATE runs SET coordinator_handle = ?, coordinator_pane_key = ?,
         consumer_generation = 2 WHERE id = ?`
      )
      .run('coordinator-2', 'tab-2:leaf-2', run.id)
    const lease = database.reserveMaestroTerminalLease({
      requestId: 'coordinator-current-generation',
      executionHostId: 'local',
      workspaceKey: 'worktree:execution-one',
      runId: run.id,
      coordinatorGeneration: 2,
      role: 'coordinator',
      coordinatorRunId: run.id,
      title: 'Current coordinator',
      launchProfile: {
        agent: 'codex',
        model: 'gpt-5.6-sol',
        effort: 'high',
        permissionMode: 'default',
        routeRef: null
      },
      spawnedBy: 'handoff',
      ownerPrincipal: 'coordinator:g2',
      retentionPolicy: 'retain'
    })
    database.attachMaestroTerminalLease({
      leaseId: lease.id,
      terminalHandle: 'coordinator-2',
      tabId: 'tab-2',
      paneKey: 'tab-2:leaf-2',
      ptyIncarnation: 'pty-2:1',
      processRootId: 'pty-2'
    })
    database.retainMaestroTerminalLease(lease.id)
    const rpcContext = context(database, [MAESTRO_RUN_PROGRESS_V2_RUNTIME_CAPABILITY])
    vi.mocked(rpcContext.runtime.showTerminal).mockImplementation(
      async () =>
        ({
          tabId: 'tab-2',
          worktreeId: database.getMaestroTerminalLease(lease.id)?.workspaceKey ?? '',
          connected: true
        }) as never
    )
    vi.mocked(rpcContext.runtime.getTerminalPaneKey).mockReturnValue('tab-2:leaf-2')
    vi.mocked(rpcContext.runtime.getTerminalProcessIncarnation).mockReturnValue('pty-2:1')
    vi.mocked(rpcContext.runtime.getTerminalLivenessVerdict).mockReturnValue({
      status: 'live',
      ptyIds: ['pty-2']
    })

    const stale = await readMaestroRunProgress(rpcContext, {
      execution_host_id: 'local',
      workspace_key: 'folder:home-1'
    })
    expect(stale).toMatchObject({
      schemaVersion: 2,
      selectedRunId: run.id,
      projectionHealth: { state: 'stale', revision: 4 },
      progress: {
        projection_health: { state: 'stale', revision: 4 },
        resources: expect.arrayContaining([
          expect.objectContaining({
            kind: 'coordinator',
            state: 'recovered',
            terminal_handle: 'coordinator-2',
            liveness: 'live'
          })
        ])
      }
    })

    database.db
      .prepare('UPDATE maestro_terminal_leases SET workspace_key = ? WHERE id = ?')
      .run('folder:home-1', lease.id)
    database.db.prepare('DELETE FROM maestro_run_projections WHERE run_id = ?').run(run.id)
    const projectionFree = await readMaestroRunProgress(rpcContext, {
      execution_host_id: 'local',
      workspace_key: 'folder:home-1'
    })
    expect(projectionFree).toMatchObject({
      schemaVersion: 2,
      selectedRunId: run.id,
      projectionHealth: { state: 'recovered', revision: null },
      progress: {
        projection_health: {
          state: 'partial',
          warning: expect.stringContaining('authenticated managed workspace binding')
        }
      }
    })
    database.close()
  })
})
