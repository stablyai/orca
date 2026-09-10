import { describe, expect, it, vi } from 'vitest'
import type { FolderWorkspace } from '../../../../shared/folder-workspace-types'
import type {
  MaestroDocumentAuthoringMutation,
  MaestroDocumentReadScope,
  MaestroDocumentLayoutMutation,
  MaestroWorkspaceAnchor
} from '../../../../shared/maestro-contract'
import { OrchestrationDb } from '../../orchestration/db/orchestration-db'
import { applyMaestroProjection } from '../../orchestration/db/maestro/maestro-projection-store'
import type { OrchestrationCompatibilityTerminalAuthority } from '../../orca-runtime'
import type { RpcContext, RpcMethod } from '../core'
import { resolveMaestroPrincipal } from '../maestro-principal'
import { MAESTRO_METHODS } from './maestro'

const FOLDER_WORKSPACE: FolderWorkspace = {
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
  const found = MAESTRO_METHODS.find((candidate) => candidate.name === name)
  if (!found) {
    throw new Error(`Missing Maestro RPC method: ${name}`)
  }
  return found
}

function rpcContext(
  db: OrchestrationDb,
  options: {
    folders?: FolderWorkspace[]
    terminalWorkspaceId?: string
    terminalHostScope?: OrchestrationCompatibilityTerminalAuthority['hostScope']
    terminalPtyId?: string
    worktree?: {
      id: string
      repoId: string
      hostId?: 'local' | `ssh:${string}` | `runtime:${string}`
    }
    repos?: { id: string; connectionId?: string | null; executionHostId?: string | null }[]
    coordinator?: { runId: string; generation: number }
    openMaestroCanvas?: (target: {
      executionHostId: string
      workspaceKey: string
    }) => Promise<boolean>
  } = {}
): RpcContext {
  const terminalHandle = 'terminal-1'
  const paneKey = 'tab-1:leaf-1'
  const runtime = {
    getOrchestrationDb: () => db,
    listFolderWorkspaces: () => options.folders ?? [FOLDER_WORKSPACE],
    listRepos: () => options.repos ?? [],
    showManagedWorktree: async () => {
      if (options.worktree) {
        return options.worktree
      }
      throw new Error('selector_not_found')
    },
    verifyOrchestrationCompatibilityCaller: () => null,
    getOrchestrationDispatchAuthority: (handle: string) =>
      handle === terminalHandle && options.terminalWorkspaceId
        ? {
            runtimeId: 'runtime-1',
            terminalHandle,
            ptyId: options.terminalPtyId ?? 'pty-1',
            worktreeId: options.terminalWorkspaceId,
            processIncarnation: 'pty-1:incarnation-1',
            paneKey,
            launchTokenHash: 'hash-1',
            hostScope: options.terminalHostScope ?? { kind: 'local', hostId: 'local' }
          }
        : null,
    resolveTerminalContext: (handle: string) =>
      handle === terminalHandle && options.terminalWorkspaceId
        ? { worktreeId: options.terminalWorkspaceId, connectionId: null }
        : null,
    openMaestroCanvas: options.openMaestroCanvas ?? (async () => false)
  } as unknown as RpcContext['runtime']
  return {
    runtime,
    ...(options.coordinator
      ? {
          legacyCoordinatorAuthority: {
            runId: options.coordinator.runId,
            principalId: 'coordinator-1',
            terminalHandle,
            paneKey,
            consumerGeneration: options.coordinator.generation
          }
        }
      : {})
  }
}

function workspace(runId: string): MaestroWorkspaceAnchor {
  return {
    repository_id: 'repo-1',
    execution_host_id: 'local',
    workspace_key: 'folder:folder-1',
    run_id: runId
  }
}

function documentScope(
  overrides: Partial<MaestroDocumentReadScope> = {}
): MaestroDocumentReadScope {
  return {
    execution_host_id: 'local',
    workspace_key: 'folder:folder-1',
    ...overrides
  }
}

function seedCurrentProjection(
  db: OrchestrationDb,
  anchor: MaestroWorkspaceAnchor,
  generation: number,
  executionWorkspace: MaestroDocumentReadScope = {
    execution_host_id: anchor.execution_host_id,
    workspace_key: anchor.workspace_key
  }
): void {
  applyMaestroProjection.call(db, anchor, {
    schema_version: 1,
    protocol: 'agent-graph-view/v1',
    kind: 'snapshot',
    workspace_scope: {
      schema_version: 1,
      repository_id: anchor.repository_id,
      canonical_root: '/workspace/one',
      execution_host: { id: anchor.execution_host_id, boundary: 'local' },
      orchestration_home: {
        execution_host_id: anchor.execution_host_id,
        workspace_key: anchor.workspace_key,
        kind: 'folder',
        path: '/workspace/one'
      },
      execution_workspace: {
        execution_host_id: executionWorkspace.execution_host_id,
        workspace_key: executionWorkspace.workspace_key,
        kind: 'folder',
        path:
          executionWorkspace.workspace_key === anchor.workspace_key
            ? '/workspace/one'
            : '/workspace/execution'
      },
      base_revision: 'base-1',
      dirty_paths: [],
      run_id: anchor.run_id,
      coordinator_generation: generation,
      binding_receipt_ref: 'artifact:workspace-bootstrap.json',
      binding_receipt_hash: `sha256:${'a'.repeat(64)}`
    },
    change: 'ORC-03B',
    run_id: anchor.run_id,
    coordinator: { id: 'coordinator-1', generation },
    capabilities: {
      agents: ['codex'],
      efforts: ['medium'],
      placement_kinds: ['current-workspace'],
      watch_deltas: false
    },
    nodes: [],
    edges: [],
    removed_node_ids: [],
    removed_edge_ids: [],
    revision: 1,
    cursor: null,
    from_cursor: null,
    reset_required: false,
    progress: undefined
  })
}

describe('Maestro RPC methods', () => {
  it('reads without a run and rejects host or workspace mismatches', async () => {
    const db = new OrchestrationDb(':memory:')
    const context = rpcContext(db)
    const requests = [
      documentScope({ execution_host_id: 'ssh:other' }),
      documentScope({ workspace_key: 'folder:folder-2' })
    ]

    await expect(
      method('maestro.document.get').handler({ scope: documentScope() }, context)
    ).resolves.toEqual({ state: 'empty', revision: null, document: null, updatedAt: null })

    for (const requestScope of requests) {
      await expect(
        method('maestro.document.get').handler({ scope: requestScope }, context)
      ).rejects.toMatchObject({ code: 'unauthorized' })
    }
    expect(db.db.prepare('SELECT COUNT(*) AS count FROM maestro_documents').get()).toEqual({
      count: 0
    })
    db.close()
  })

  it('reads a persisted document through the host and workspace scope', async () => {
    const db = new OrchestrationDb(':memory:')
    db.applyMaestroMutation(
      {
        schema_version: 1,
        protocol: 'maestro-mutation/v1',
        mutation_id: 'mutation-1',
        workspace: workspace('run-1'),
        actor: {
          actor_id: 'user-1',
          kind: 'user',
          authenticated: true,
          session_id: 'session-1'
        },
        coordinator_generation: 1,
        expected_revision: 0,
        operation: { kind: 'move-node', node_id: 'node-1', position: { x: 10, y: 20 } }
      },
      {
        actor_id: 'user-1',
        kind: 'user',
        authenticated: true,
        session_id: 'session-1',
        workspace: {
          execution_host_id: 'local',
          workspace_key: 'folder:folder-1',
          run_id: 'run-1'
        }
      }
    )

    await expect(
      method('maestro.document.get').handler({ scope: documentScope() }, rpcContext(db))
    ).resolves.toMatchObject({
      state: 'ready',
      revision: 1,
      document: { nodes: { 'node-1': { position: { x: 10, y: 20 } } } }
    })
    db.close()
  })

  it('opens only the authenticated exact workspace Canvas', async () => {
    const db = new OrchestrationDb(':memory:')
    const openMaestroCanvas = vi.fn().mockResolvedValue(true)

    await expect(
      method('maestro.canvas.open').handler(
        { execution_host_id: 'local', workspace_key: 'folder:folder-1' },
        rpcContext(db, { openMaestroCanvas })
      )
    ).resolves.toEqual({
      opened: true,
      execution_host_id: 'local',
      workspace_key: 'folder:folder-1'
    })
    expect(openMaestroCanvas).toHaveBeenCalledWith({
      executionHostId: 'local',
      workspaceKey: 'folder:folder-1'
    })
    db.close()
  })

  it('authorizes pair-scoped layout writes without a run anchor', async () => {
    const db = new OrchestrationDb(':memory:')
    const mutation: MaestroDocumentLayoutMutation = {
      schema_version: 1,
      protocol: 'maestro-document-layout-mutation/v1',
      mutation_id: 'layout-1',
      scope: documentScope(),
      expected_revision: 0,
      operation: { kind: 'set-viewport', viewport: { center: { x: 12, y: 18 }, zoom: 1.25 } }
    }

    await expect(
      method('maestro.document.layout.apply').handler(mutation, rpcContext(db))
    ).resolves.toEqual({ outcome: 'applied', revision: 1, affectedIds: [] })
    await expect(
      method('maestro.document.layout.apply').handler(
        { ...mutation, scope: documentScope({ workspace_key: 'folder:folder-2' }) },
        rpcContext(db)
      )
    ).rejects.toMatchObject({ code: 'unauthorized' })
    db.close()
  })

  it('binds a pair authoring mutation to the current server-owned run', async () => {
    const db = new OrchestrationDb(':memory:')
    const run = db.createRun({
      objective: 'RPC authoring authority',
      coordinatorHandle: 'coordinator-1',
      coordinatorPaneKey: 'tab-1:leaf-1'
    })
    const context = rpcContext(db)
    const runWorkspace = workspace(run.id)
    seedCurrentProjection(db, runWorkspace, run.consumer_generation)
    await expect(
      method('maestro.mutation.apply').handler(
        {
          schema_version: 1,
          protocol: 'maestro-mutation/v1',
          mutation_id: 'rpc-bind-run',
          workspace: runWorkspace,
          actor: {
            actor_id: 'renderer',
            kind: 'user',
            authenticated: true,
            session_id: 'renderer'
          },
          coordinator_generation: 1,
          expected_revision: 0,
          operation: { kind: 'move-node', node_id: 'rpc-node', position: { x: 1, y: 2 } }
        },
        context
      )
    ).resolves.toMatchObject({ outcome: 'applied', revision: 1 })
    const scope = runWorkspace
    const createNote: MaestroDocumentAuthoringMutation = {
      schema_version: 1,
      protocol: 'maestro-document-authoring-mutation/v1',
      mutation_id: 'rpc-note',
      scope,
      expected_revision: 1,
      operation: {
        kind: 'create-note',
        node_id: 'rpc-note',
        position: { x: 3, y: 4 },
        title: 'RPC note',
        markdown: '# RPC'
      }
    }
    await expect(
      method('maestro.document.authoring.apply').handler(createNote, context)
    ).resolves.toMatchObject({ outcome: 'applied', revision: 2 })
    await expect(
      method('maestro.document.authoring.apply').handler(
        {
          ...createNote,
          mutation_id: 'rpc-edge',
          expected_revision: 2,
          operation: {
            kind: 'create-edge',
            id: 'rpc-edge',
            source_id: 'rpc-node',
            target_id: 'rpc-note',
            type: 'context_for',
            direction: 'forward',
            context_note_id: 'rpc-note',
            expected_note_revision: 1
          }
        },
        context
      )
    ).resolves.toMatchObject({ outcome: 'applied', revision: 3 })
    expect(db.getMaestroDocument(scope).document?.edges[0]?.context_snapshot_id).toMatch(
      /^snapshot-/
    )
    await expect(
      method('maestro.document.authoring.apply').handler(
        {
          ...createNote,
          mutation_id: 'rpc-forged-anchor',
          expected_revision: 3,
          scope: { ...runWorkspace, run_id: 'run-forged' }
        },
        context
      )
    ).rejects.toMatchObject({ code: 'run_not_found' })
    db.close()
  })

  it('backfills a layout-first document only through its authenticated authoring anchor', async () => {
    const db = new OrchestrationDb(':memory:')
    const run = db.createRun({
      objective: 'RPC authoring backfill',
      coordinatorHandle: 'coordinator-1',
      coordinatorPaneKey: 'tab-1:leaf-1'
    })
    const context = rpcContext(db)
    seedCurrentProjection(db, workspace(run.id), run.consumer_generation)
    await expect(
      method('maestro.document.layout.apply').handler(
        {
          schema_version: 1,
          protocol: 'maestro-document-layout-mutation/v1',
          mutation_id: 'rpc-layout-first',
          scope: documentScope(),
          expected_revision: 0,
          operation: { kind: 'set-viewport', viewport: { center: { x: 0, y: 0 }, zoom: 1 } }
        },
        context
      )
    ).resolves.toMatchObject({ outcome: 'applied', revision: 1 })
    await expect(
      method('maestro.document.authoring.apply').handler(
        {
          schema_version: 1,
          protocol: 'maestro-document-authoring-mutation/v1',
          mutation_id: 'rpc-authoring-backfill',
          scope: workspace(run.id),
          expected_revision: 1,
          operation: {
            kind: 'create-note',
            node_id: 'rpc-bound-note',
            position: { x: 1, y: 1 },
            title: 'Bound',
            markdown: '# Bound'
          }
        },
        context
      )
    ).resolves.toMatchObject({ outcome: 'applied', revision: 2 })
    await expect(
      method('maestro.document.authoring.apply').handler(
        {
          schema_version: 1,
          protocol: 'maestro-document-authoring-mutation/v1',
          mutation_id: 'rpc-cross-run',
          scope: {
            ...workspace(run.id),
            run_id: db.createRun({
              objective: 'Other projection run',
              coordinatorHandle: 'coordinator-2',
              coordinatorPaneKey: 'tab-2:leaf-1'
            }).id
          },
          expected_revision: 2,
          operation: {
            kind: 'create-note',
            node_id: 'rpc-cross-note',
            position: { x: 2, y: 2 },
            title: 'Cross',
            markdown: '# Cross'
          }
        },
        context
      )
    ).rejects.toMatchObject({ code: 'unauthorized' })
    db.close()
  })

  it('rejects authoring without a current projection or an exact repository anchor', async () => {
    const db = new OrchestrationDb(':memory:')
    const run = db.createRun({
      objective: 'Projection authoring gate',
      coordinatorHandle: 'coordinator-1',
      coordinatorPaneKey: 'tab-1:leaf-1'
    })
    const anchor = workspace(run.id)
    const mutation = {
      schema_version: 1,
      protocol: 'maestro-document-authoring-mutation/v1',
      mutation_id: 'projection-gate',
      expected_revision: 0,
      operation: {
        kind: 'create-note' as const,
        node_id: 'projection-note',
        position: { x: 1, y: 1 },
        title: 'Projection',
        markdown: '# Projection'
      }
    }
    await expect(
      method('maestro.document.authoring.apply').handler(
        { ...mutation, scope: anchor },
        rpcContext(db)
      )
    ).rejects.toMatchObject({ code: 'unauthorized' })
    seedCurrentProjection(db, anchor, run.consumer_generation)
    await expect(
      method('maestro.document.authoring.apply').handler(
        {
          ...mutation,
          mutation_id: 'forged-repository',
          scope: { ...anchor, repository_id: 'repo-forged' }
        },
        rpcContext(db)
      )
    ).rejects.toMatchObject({ code: 'unauthorized' })
    db.close()
  })

  it('rejects a stale projection after coordinator takeover until the projection is republished', async () => {
    const db = new OrchestrationDb(':memory:')
    const run = db.createRun({
      objective: 'Projection takeover fence',
      coordinatorHandle: 'coordinator-1',
      coordinatorPaneKey: 'tab-1:leaf-1'
    })
    const anchor = workspace(run.id)
    seedCurrentProjection(db, anchor, run.consumer_generation)
    const mutation = {
      schema_version: 1,
      protocol: 'maestro-document-authoring-mutation/v1',
      mutation_id: 'takeover-anchor',
      scope: anchor,
      expected_revision: 0,
      operation: {
        kind: 'create-note' as const,
        node_id: 'takeover-note',
        position: { x: 1, y: 1 },
        title: 'Takeover',
        markdown: '# Takeover'
      }
    }
    db.bindRun({
      runId: run.id,
      coordinatorHandle: 'coordinator-2',
      coordinatorPaneKey: 'tab-2:leaf-1'
    })
    await expect(
      method('maestro.document.authoring.apply').handler(mutation, rpcContext(db))
    ).rejects.toMatchObject({ code: 'unauthorized' })
    const currentRun = db.getRun(run.id)
    if (!currentRun) {
      throw new Error('Expected the takeover run to remain available.')
    }
    seedCurrentProjection(db, anchor, currentRun.consumer_generation)
    await expect(
      method('maestro.document.authoring.apply').handler(mutation, rpcContext(db))
    ).resolves.toMatchObject({ outcome: 'applied', revision: 1 })
    db.close()
  })

  it('rejects a reused coordinator principal outside its workspace or generation', async () => {
    const db = new OrchestrationDb(':memory:')
    const run = db.createRun({
      objective: 'Test coordinator authority',
      coordinatorHandle: 'terminal-1',
      coordinatorPaneKey: 'tab-1:leaf-1'
    })
    const otherFolder = { ...FOLDER_WORKSPACE, id: 'folder-2', folderPath: '/workspace/two' }
    const otherWorkspace = { ...workspace(run.id), workspace_key: 'folder:folder-2' }

    await expect(
      method('maestro.intent.take').handler(
        { intentId: 'intent-1', workspace: otherWorkspace },
        rpcContext(db, {
          folders: [FOLDER_WORKSPACE, otherFolder],
          terminalWorkspaceId: 'folder:folder-1',
          coordinator: { runId: run.id, generation: run.consumer_generation }
        })
      )
    ).rejects.toMatchObject({ code: 'unauthorized' })
    await expect(
      method('maestro.intent.take').handler(
        { intentId: 'intent-1', workspace: workspace(run.id) },
        rpcContext(db, {
          terminalWorkspaceId: 'folder:folder-1',
          coordinator: { runId: run.id, generation: run.consumer_generation + 1 }
        })
      )
    ).rejects.toMatchObject({ code: 'unauthorized' })
    db.close()
  })

  it('lets the current coordinator act in its projected execution workspace only', async () => {
    const db = new OrchestrationDb(':memory:')
    const run = db.createRun({
      objective: 'Coordinate a split workspace',
      coordinatorHandle: 'terminal-1',
      coordinatorPaneKey: 'tab-1:leaf-1'
    })
    const executionFolder = {
      ...FOLDER_WORKSPACE,
      id: 'folder-2',
      name: 'Execution',
      folderPath: '/workspace/execution'
    }
    const unrelatedFolder = {
      ...FOLDER_WORKSPACE,
      id: 'folder-3',
      name: 'Unrelated',
      folderPath: '/workspace/unrelated'
    }
    const executionWorkspace = {
      repository_id: 'execution-folder',
      execution_host_id: 'local',
      workspace_key: 'folder:folder-2',
      run_id: run.id
    }
    seedCurrentProjection(db, workspace(run.id), run.consumer_generation, executionWorkspace)

    await expect(
      resolveMaestroPrincipal(
        rpcContext(db, {
          folders: [FOLDER_WORKSPACE, executionFolder, unrelatedFolder],
          terminalWorkspaceId: 'folder:folder-1',
          coordinator: { runId: run.id, generation: run.consumer_generation }
        }),
        executionWorkspace
      )
    ).resolves.toMatchObject({
      kind: 'coordinator',
      workspace: {
        execution_host_id: 'local',
        workspace_key: 'folder:folder-2',
        run_id: run.id
      }
    })

    await expect(
      resolveMaestroPrincipal(
        rpcContext(db, {
          folders: [FOLDER_WORKSPACE, executionFolder, unrelatedFolder],
          terminalWorkspaceId: 'folder:folder-3',
          coordinator: { runId: run.id, generation: run.consumer_generation }
        }),
        executionWorkspace
      )
    ).rejects.toMatchObject({
      code: 'unauthorized',
      data: {
        requested: { workspaceKey: 'folder:folder-2' },
        caller: { workspaceKey: 'folder:folder-3' }
      }
    })
    db.close()
  })

  it('binds repository identity and preserves canonical WSL and runtime host aliases', async () => {
    const db = new OrchestrationDb(':memory:')
    const run = db.createRun({
      objective: 'Test canonical host authority',
      coordinatorHandle: 'terminal-1',
      coordinatorPaneKey: 'tab-1:leaf-1'
    })
    const coordinator = { runId: run.id, generation: run.consumer_generation }

    await expect(
      resolveMaestroPrincipal(
        rpcContext(db, {
          terminalWorkspaceId: 'folder:folder-1',
          terminalHostScope: { kind: 'wsl', hostId: 'local', distro: 'Ubuntu' },
          coordinator
        }),
        workspace(run.id)
      )
    ).resolves.toMatchObject({ kind: 'coordinator', workspace: { execution_host_id: 'local' } })

    const runtimeFolder = {
      ...FOLDER_WORKSPACE,
      executionHostId: 'runtime:env-1' as const
    }
    const runtimeWorkspace = { ...workspace(run.id), execution_host_id: 'runtime:env-1' }
    const runtimeContext = rpcContext(db, {
      folders: [runtimeFolder],
      terminalWorkspaceId: 'folder:folder-1',
      terminalHostScope: { kind: 'ssh', targetId: 'runtime-ssh-env-1' },
      coordinator
    })
    await expect(resolveMaestroPrincipal(runtimeContext, runtimeWorkspace)).resolves.toMatchObject({
      workspace: { execution_host_id: 'runtime:env-1' }
    })
    await expect(
      resolveMaestroPrincipal(runtimeContext, {
        ...runtimeWorkspace,
        repository_id: 'folder-metadata-from-another-run'
      })
    ).resolves.toMatchObject({ workspace: { workspace_key: 'folder:folder-1' } })
    await expect(
      resolveMaestroPrincipal(runtimeContext, {
        ...runtimeWorkspace,
        execution_host_id: 'runtime:env-2'
      })
    ).rejects.toMatchObject({ code: 'unauthorized' })
    await expect(
      resolveMaestroPrincipal(
        rpcContext(db, {
          folders: [{ ...runtimeFolder, executionHostId: 'runtime:env-2' }],
          terminalWorkspaceId: 'folder:folder-1',
          terminalHostScope: { kind: 'ssh', targetId: 'runtime-ssh-env-1' },
          coordinator
        }),
        { ...runtimeWorkspace, execution_host_id: 'runtime:env-2' }
      )
    ).rejects.toMatchObject({ code: 'unauthorized' })

    const worktreeContext = rpcContext(db, {
      worktree: { id: 'repo-1::/workspace', repoId: 'repo-1', hostId: 'local' },
      repos: [{ id: 'repo-1', executionHostId: 'local' }]
    })
    const worktreeWorkspace: MaestroWorkspaceAnchor = {
      repository_id: 'repo-1',
      execution_host_id: 'local',
      workspace_key: 'worktree:repo-1::/workspace',
      run_id: run.id
    }
    await expect(
      resolveMaestroPrincipal(worktreeContext, worktreeWorkspace)
    ).resolves.toMatchObject({ workspace: { workspace_key: 'worktree:repo-1::/workspace' } })
    await expect(
      resolveMaestroPrincipal(worktreeContext, {
        ...worktreeWorkspace,
        repository_id: 'repo-other'
      })
    ).rejects.toMatchObject({ code: 'unauthorized' })
    db.close()
  })
})
