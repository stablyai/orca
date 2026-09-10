import { describe, expect, it } from 'vitest'
import type { AgentGraphView } from '../../../../shared/maestro-contract'
import type { FolderWorkspace } from '../../../../shared/folder-workspace-types'
import { OrchestrationDb } from '../../orchestration/db/orchestration-db'
import type { RpcContext, RpcMethod } from '../core'
import { MAESTRO_PROJECTION_METHODS } from './maestro-projection'

const FOLDER: FolderWorkspace = {
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

function method(name: string): RpcMethod {
  const found = MAESTRO_PROJECTION_METHODS.find((candidate) => candidate.name === name)
  if (!found) {
    throw new Error(`Missing method ${name}`)
  }
  return found
}

function context(database: OrchestrationDb, runId: string, generation: number): RpcContext {
  return {
    runtime: {
      getOrchestrationDb: () => database,
      listFolderWorkspaces: () => [FOLDER],
      listRepos: () => [],
      getOrchestrationDispatchAuthority: () => ({
        runtimeId: 'runtime-1',
        terminalHandle: 'coordinator-1',
        ptyId: 'pty-1',
        worktreeId: 'folder:home-1',
        processIncarnation: 'pty-1:incarnation-1',
        paneKey: 'tab-1:leaf-1',
        launchTokenHash: 'hash-1',
        hostScope: { kind: 'local', hostId: 'local' }
      })
    } as unknown as RpcContext['runtime'],
    legacyCoordinatorAuthority: {
      runId,
      principalId: 'coordinator-1',
      terminalHandle: 'coordinator-1',
      paneKey: 'tab-1:leaf-1',
      consumerGeneration: generation
    }
  }
}

function view(runId: string, generation: number): AgentGraphView {
  return {
    schema_version: 1,
    protocol: 'agent-graph-view/v1',
    kind: 'snapshot',
    workspace_scope: {
      schema_version: 1,
      repository_id: 'home-1',
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
      run_id: runId,
      coordinator_generation: generation,
      binding_receipt_ref: 'artifact:workspace-bootstrap/one.json',
      binding_receipt_hash: `sha256:${'a'.repeat(64)}`
    },
    change: 'orchestration-run',
    run_id: runId,
    coordinator: { id: 'coordinator-1', generation },
    capabilities: {
      agents: [],
      efforts: [],
      placement_kinds: ['current-workspace'],
      watch_deltas: true
    },
    nodes: [],
    edges: [],
    removed_node_ids: [],
    removed_edge_ids: [],
    revision: 0,
    cursor: null,
    from_cursor: null,
    reset_required: false,
    progress: undefined
  }
}

describe('Maestro projection RPC', () => {
  it('allows only the current coordinator to publish a strictly validated projection', async () => {
    const database = new OrchestrationDb(':memory:')
    const run = database.createRun({
      objective: 'Projection RPC',
      coordinatorHandle: 'coordinator-1',
      coordinatorPaneKey: 'tab-1:leaf-1'
    })
    const workspace = {
      repository_id: 'home-1',
      execution_host_id: 'local',
      workspace_key: 'folder:home-1',
      run_id: run.id
    }

    await expect(
      method('maestro.projection.apply').handler(
        { workspace, view: view(run.id, run.consumer_generation) },
        context(database, run.id, run.consumer_generation)
      )
    ).resolves.toMatchObject({ runId: run.id, revision: 0 })
    await expect(
      method('maestro.projection.apply').handler(
        { workspace, view: view(run.id, run.consumer_generation + 1) },
        context(database, run.id, run.consumer_generation)
      )
    ).rejects.toMatchObject({ code: 'unauthorized' })
    database.close()
  })

  it('reads the exact host and workspace projection only', async () => {
    const database = new OrchestrationDb(':memory:')
    const run = database.createRun({
      objective: 'Projection read',
      coordinatorHandle: 'coordinator-1',
      coordinatorPaneKey: 'tab-1:leaf-1'
    })
    const rpcContext = context(database, run.id, run.consumer_generation)
    await method('maestro.projection.apply').handler(
      {
        workspace: {
          repository_id: 'home-1',
          execution_host_id: 'local',
          workspace_key: 'folder:home-1',
          run_id: run.id
        },
        view: view(run.id, run.consumer_generation)
      },
      rpcContext
    )

    await expect(
      method('maestro.projection.get').handler(
        { scope: { execution_host_id: 'local', workspace_key: 'folder:home-1' } },
        rpcContext
      )
    ).resolves.toMatchObject({ runId: run.id, revision: 0 })
    await expect(
      method('maestro.projection.get').handler(
        { scope: { execution_host_id: 'ssh:other', workspace_key: 'folder:home-1' } },
        rpcContext
      )
    ).rejects.toMatchObject({ code: 'unauthorized' })
    database.close()
  })
})
