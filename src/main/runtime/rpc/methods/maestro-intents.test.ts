import { describe, expect, it } from 'vitest'
import type { FolderWorkspace } from '../../../../shared/folder-workspace-types'
import { OrchestrationDb } from '../../orchestration/db/orchestration-db'
import {
  applyMaestroProjection,
  getMaestroProjection
} from '../../orchestration/db/maestro/maestro-projection-store'
import type { RpcContext, RpcMethod } from '../core'
import { MAESTRO_INTENT_METHODS } from './maestro-intents'
import { getMaestroDelegationCatalogSnapshot } from './maestro-delegation-catalog'

const folder: FolderWorkspace = {
  id: 'folder-1',
  projectGroupId: 'group-1',
  name: 'Workspace one',
  folderPath: '/workspace/one',
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
  const found = MAESTRO_INTENT_METHODS.find((candidate) => candidate.name === name)
  if (!found) {
    throw new Error(`Missing method ${name}`)
  }
  return found
}

function context(db: OrchestrationDb): RpcContext {
  const runtime = {
    getOrchestrationDb: () => db,
    listFolderWorkspaces: () => [folder],
    listManagedWorktrees: async () => ({ worktrees: [], totalCount: 0, truncated: false }),
    listRepos: () => [],
    showManagedWorktree: async () => {
      throw new Error('not used')
    },
    validateOrchestrationAgentLauncher: () => undefined,
    verifyOrchestrationCompatibilityCaller: () => null,
    getOrchestrationDispatchAuthority: () => null,
    getClientSettings: () => ({ disabledTuiAgents: [], agentDefaultArgs: {}, agentDefaultEnv: {} })
  } as unknown as RpcContext['runtime']
  return { runtime }
}

function runtimeWith(
  db: OrchestrationDb,
  overrides: Record<string, unknown> = {}
): RpcContext['runtime'] {
  return {
    getOrchestrationDb: () => db,
    listFolderWorkspaces: () => [folder],
    listManagedWorktrees: async () => ({ worktrees: [], totalCount: 0, truncated: false }),
    listRepos: () => [],
    showManagedWorktree: async () => {
      throw new Error('not used')
    },
    validateOrchestrationAgentLauncher: () => undefined,
    verifyOrchestrationCompatibilityCaller: () => null,
    getOrchestrationDispatchAuthority: () => null,
    getClientSettings: () => ({ disabledTuiAgents: [], agentDefaultArgs: {}, agentDefaultEnv: {} }),
    ...overrides
  } as unknown as RpcContext['runtime']
}

const workspace = {
  repository_id: 'repo-1',
  execution_host_id: 'local',
  workspace_key: 'folder:folder-1',
  run_id: 'run-1'
}

function seedHarnessLineage(
  db: OrchestrationDb,
  runId: string,
  generation: number,
  statuses = { task: 'running', attempt: 'running' }
): void {
  const revision = (getMaestroProjection.call(db, workspace, runId)?.revision ?? 0) + 1
  applyMaestroProjection.call(
    db,
    { ...workspace, run_id: runId },
    {
      schema_version: 1,
      protocol: 'agent-graph-view/v1',
      kind: 'snapshot',
      workspace_scope: {
        schema_version: 1,
        repository_id: 'repo-1',
        canonical_root: '/workspace/one',
        execution_host: { id: 'local', boundary: 'local' },
        orchestration_home: {
          execution_host_id: 'local',
          workspace_key: 'folder:folder-1',
          kind: 'folder',
          path: '/workspace/one'
        },
        execution_workspace: {
          execution_host_id: 'local',
          workspace_key: 'folder:folder-1',
          kind: 'folder',
          path: '/workspace/one'
        },
        base_revision: 'base-1',
        dirty_paths: [],
        run_id: runId,
        coordinator_generation: generation,
        binding_receipt_ref: 'artifact:workspace-bootstrap.json',
        binding_receipt_hash: `sha256:${'a'.repeat(64)}`
      },
      change: 'ORC-05',
      run_id: runId,
      coordinator: { id: 'coordinator-1', generation },
      capabilities: {
        agents: ['codex'],
        efforts: ['high'],
        placement_kinds: ['current-workspace'],
        watch_deltas: false
      },
      nodes: [
        {
          id: 'task-ORC-05',
          type: 'task',
          status: statuses.task,
          summary: 'Harness task',
          task_id: 'ORC-05'
        },
        {
          id: 'attempt-attempt-orc-05-001',
          type: 'attempt',
          status: statuses.attempt,
          summary: 'Harness attempt',
          task_id: 'ORC-05',
          attempt_id: 'attempt-orc-05-001'
        }
      ],
      edges: [],
      removed_node_ids: [],
      removed_edge_ids: [],
      revision,
      cursor: null,
      from_cursor: null,
      reset_required: false,
      progress: {
        schema_version: 1,
        state: 'active',
        progress_percent: 10,
        task_counts: {
          approved: 0,
          running: 1,
          input_required: 0,
          blocked: 0,
          pending: 0,
          failed: 0
        },
        current_tasks: [{ task_id: 'ORC-05', attempt_id: 'attempt-orc-05-001', status: 'running' }],
        next_tasks: [],
        cleanup: {
          pending: { count: 0, ids: [], truncated: false },
          unverifiable: { count: 0, ids: [], truncated: false },
          failed: { count: 0, ids: [], truncated: false },
          retained: { count: 0, ids: [], truncated: false }
        },
        last_activity: null,
        blockers: [],
        material_findings: []
      }
    }
  )
}

function delegationRequest(
  runId: string,
  intentId: string,
  source: unknown,
  parentTaskId: string | null,
  parentAttemptId: string | null
) {
  return {
    schema_version: 1,
    protocol: 'maestro-delegation/v1',
    intent_id: intentId,
    workspace: { ...workspace, run_id: runId },
    source,
    parent_task_id: parentTaskId,
    parent_attempt_id: parentAttemptId,
    purpose: 'Bounded Harness work',
    role: 'implementation',
    requested: { lane: 'balanced', agent: null, model: null, effort: null },
    placement_request: { kind: 'current-workspace' },
    context_refs: ['harness-context'],
    paths: ['src/feature.ts'],
    check: 'pnpm test'
  }
}

describe('Maestro delegation RPC methods', () => {
  it('returns runtime-owned catalog entries without accepting a permission override', async () => {
    const db = new OrchestrationDb(':memory:')
    const run = db.createRun({
      objective: 'Delegation',
      coordinatorHandle: 'coordinator-1',
      coordinatorPaneKey: 'tab-1:leaf-1'
    })
    const result = await method('maestro.delegation.catalog').handler(
      { workspace: { ...workspace, run_id: run.id } },
      context(db)
    )
    expect(result).toMatchObject({
      permission_mode: { display_only: true },
      placements: expect.any(Array)
    })
    db.close()
  })

  it('lists folder and managed-worktree identities and disables missing current identity', async () => {
    const db = new OrchestrationDb(':memory:')
    const run = db.createRun({
      objective: 'Delegation',
      coordinatorHandle: 'coordinator-1',
      coordinatorPaneKey: 'tab-1:leaf-1'
    })
    const managed = {
      id: 'repo-1::/workspace/child',
      repoId: 'repo-1',
      hostId: 'ssh:build-host',
      displayName: 'Child worktree'
    }
    const runtime = runtimeWith(db, {
      listManagedWorktrees: async () => ({ worktrees: [managed], totalCount: 1, truncated: false }),
      listRepos: () => [{ id: 'repo-1', connectionId: null, executionHostId: 'ssh:build-host' }]
    })
    const result = await getMaestroDelegationCatalogSnapshot(runtime, {
      ...workspace,
      run_id: run.id
    })
    expect(result.catalog.placements).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          placement: {
            kind: 'existing-workspace',
            execution_host_id: 'local',
            workspace_key: 'folder:folder-1'
          }
        }),
        expect.objectContaining({
          placement: {
            kind: 'existing-workspace',
            execution_host_id: 'ssh:build-host',
            workspace_key: 'worktree:repo-1::/workspace/child'
          }
        })
      ])
    )
    const missing = await getMaestroDelegationCatalogSnapshot(runtime, {
      ...workspace,
      workspace_key: 'worktree:missing',
      run_id: run.id
    })
    expect(missing.currentWorkspace).toBeNull()
    expect(
      missing.catalog.placements.find((entry) => entry.placement.kind === 'current-workspace')
    ).toMatchObject({ enabled: false })
    db.close()
  })

  it('rejects a disabled agent at the request boundary', async () => {
    const db = new OrchestrationDb(':memory:')
    const run = db.createRun({
      objective: 'Delegation',
      coordinatorHandle: 'coordinator-1',
      coordinatorPaneKey: 'tab-1:leaf-1'
    })
    const runtime = runtimeWith(db, {
      getClientSettings: () => ({
        disabledTuiAgents: ['claude'],
        agentDefaultArgs: {},
        agentDefaultEnv: {}
      })
    })
    await expect(
      method('maestro.delegation.request').handler(
        {
          schema_version: 1,
          protocol: 'maestro-delegation/v1',
          intent_id: 'intent-disabled',
          workspace: { ...workspace, run_id: run.id },
          source: { kind: 'canvas-point', position: { x: 1, y: 2 } },
          parent_task_id: null,
          parent_attempt_id: null,
          purpose: 'Bounded work',
          role: 'implementation',
          requested: { lane: 'balanced', agent: 'claude', model: null, effort: null },
          placement_request: { kind: 'current-workspace' },
          context_refs: [],
          paths: ['src/feature.ts'],
          check: 'pnpm test'
        },
        { runtime }
      )
    ).rejects.toThrow(/Disabled/)
    db.close()
  })

  it('rejects forged parent scope and unsupported runtime profile choices', async () => {
    const db = new OrchestrationDb(':memory:')
    const run = db.createRun({
      objective: 'Delegation',
      coordinatorHandle: 'coordinator-1',
      coordinatorPaneKey: 'tab-1:leaf-1'
    })
    const runtime = runtimeWith(db)
    const request = {
      schema_version: 1,
      protocol: 'maestro-delegation/v1',
      intent_id: 'intent-forged-parent',
      workspace: { ...workspace, run_id: run.id },
      source: { kind: 'canvas-point', position: { x: 1, y: 2 } },
      parent_task_id: 'task-forged',
      parent_attempt_id: null,
      purpose: 'Bounded work',
      role: 'implementation',
      requested: { lane: 'balanced', agent: 'codex', model: 'not-a-model', effort: null },
      placement_request: { kind: 'current-workspace' },
      context_refs: [],
      paths: ['src/feature.ts'],
      check: 'pnpm test'
    }
    await expect(
      method('maestro.delegation.request').handler(request, { runtime })
    ).rejects.toThrow(/model is not available/)
    await expect(
      method('maestro.delegation.request').handler(
        {
          ...request,
          intent_id: 'intent-unsupported-model',
          parent_task_id: null
        },
        { runtime }
      )
    ).rejects.toThrow(/model is not available/)
    db.close()
  })

  it('accepts only exact Harness task and attempt lineage from the current projection', async () => {
    const db = new OrchestrationDb(':memory:')
    const run = db.createRun({
      objective: 'Delegation',
      coordinatorHandle: 'coordinator-1',
      coordinatorPaneKey: 'tab-1:leaf-1'
    })
    const otherRun = db.createRun({
      objective: 'Other delegation',
      coordinatorHandle: 'coordinator-2',
      coordinatorPaneKey: 'tab-2:leaf-1'
    })
    seedHarnessLineage(db, run.id, run.consumer_generation)
    const runtime = runtimeWith(db)
    const request = method('maestro.delegation.request')

    await expect(
      request.handler(
        delegationRequest(
          run.id,
          'intent-harness-task',
          { kind: 'task', task_id: 'ORC-05' },
          'ORC-05',
          null
        ),
        { runtime }
      )
    ).resolves.toMatchObject({ parent_task_id: 'ORC-05', parent_attempt_id: null })
    await expect(
      request.handler(
        delegationRequest(
          run.id,
          'intent-harness-attempt',
          { kind: 'attempt', attempt_id: 'attempt-orc-05-001' },
          'ORC-05',
          'attempt-orc-05-001'
        ),
        { runtime }
      )
    ).resolves.toMatchObject({ parent_task_id: 'ORC-05', parent_attempt_id: 'attempt-orc-05-001' })
    await expect(
      request.handler(
        delegationRequest(
          run.id,
          'intent-forged-task',
          { kind: 'task', task_id: 'ORC-99' },
          'ORC-99',
          null
        ),
        { runtime }
      )
    ).rejects.toThrow(/task parent/)
    await expect(
      request.handler(
        delegationRequest(
          run.id,
          'intent-forged-attempt',
          { kind: 'attempt', attempt_id: 'attempt-orc-05-001' },
          'ORC-05',
          'attempt-forged'
        ),
        { runtime }
      )
    ).rejects.toThrow(/attempt parent/)
    await expect(
      request.handler(
        delegationRequest(
          otherRun.id,
          'intent-wrong-run',
          { kind: 'task', task_id: 'ORC-05' },
          'ORC-05',
          null
        ),
        { runtime }
      )
    ).rejects.toThrow(/authoritative Maestro projection/)
    await expect(
      request.handler(
        delegationRequest(
          run.id,
          'intent-null-parent',
          { kind: 'canvas-point', position: { x: 1, y: 2 } },
          null,
          null
        ),
        { runtime }
      )
    ).rejects.toThrow(/task parent/)
    await expect(
      request.handler(
        delegationRequest(
          run.id,
          'intent-ambient-parent',
          { kind: 'canvas-point', position: { x: 1, y: 2 } },
          'ORC-05',
          'attempt-orc-05-001'
        ),
        { runtime }
      )
    ).resolves.toMatchObject({ parent_task_id: 'ORC-05', parent_attempt_id: 'attempt-orc-05-001' })
    for (const status of ['pending', 'pass', 'graded']) {
      seedHarnessLineage(db, run.id, run.consumer_generation, { task: status, attempt: 'running' })
      await expect(
        request.handler(
          delegationRequest(
            run.id,
            `intent-${status}-task`,
            { kind: 'task', task_id: 'ORC-05' },
            'ORC-05',
            null
          ),
          { runtime }
        )
      ).rejects.toThrow(/task parent/)
      seedHarnessLineage(db, run.id, run.consumer_generation, { task: 'running', attempt: status })
      await expect(
        request.handler(
          delegationRequest(
            run.id,
            `intent-${status}-attempt`,
            { kind: 'attempt', attempt_id: 'attempt-orc-05-001' },
            'ORC-05',
            'attempt-orc-05-001'
          ),
          { runtime }
        )
      ).rejects.toThrow(/attempt parent/)
    }
    db.close()
  })
})
