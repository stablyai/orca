import { describe, expect, it, vi } from 'vitest'
import type { FolderWorkspace } from '../../../../shared/folder-workspace-types'
import {
  MAESTRO_COMPOSED_BOOTSTRAP_RUNTIME_CAPABILITY,
  WORKSPACE_BOOTSTRAP_GIT_HOME_RUNTIME_CAPABILITY,
  WORKSPACE_BOOTSTRAP_RECEIPT_V2_RUNTIME_CAPABILITY,
  type RuntimeCapability
} from '../../../../shared/protocol-version'
import { OrchestrationDb } from '../../orchestration/db/orchestration-db'
import { createRootDispatch } from '../../orchestration/db/root-dispatch-test-fixture'
import { getMaestroProjection } from '../../orchestration/db/maestro/maestro-projection-store'
import { OrcaRuntimeService } from '../../orca-runtime'
import type { RpcContext } from '../core'
import { bootstrapMaestroProjection } from './maestro-bootstrap'

const HOME_FOLDER: FolderWorkspace = {
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

function harness(
  options: {
    home?: 'folder' | 'git'
    execution?: 'folder' | 'git'
    clientCapabilities?: readonly RuntimeCapability[]
  } = {}
) {
  const gitHome = options.home === 'git'
  const homeId = gitHome ? 'repo-home::/workspace/home' : 'folder:home-1'
  const homeKey = gitHome ? `worktree:${homeId}` : homeId
  const database = new OrchestrationDb(':memory:')
  const run = database.createRun({
    objective: 'Bootstrap authoritative projection',
    coordinatorHandle: 'coordinator-1',
    coordinatorPaneKey: 'tab-1:leaf-1'
  })
  const task = database.createTask({
    runId: run.id,
    taskTitle: 'Project the Run',
    displayName: 'Projection worker',
    spec: 'Build the initial projection.'
  })
  const dispatch = createRootDispatch(database, task.id, 'worker-1', 'tab-2:leaf-1')
  const runtime = new OrcaRuntimeService()
  vi.spyOn(runtime, 'getOrchestrationDb').mockReturnValue(database)
  vi.spyOn(runtime, 'listFolderWorkspaces').mockReturnValue([HOME_FOLDER])
  vi.spyOn(runtime, 'getOrchestrationDispatchAuthority').mockImplementation((handle) =>
    handle === 'coordinator-1'
      ? ({
          runtimeId: 'runtime-1',
          terminalHandle: 'coordinator-1',
          ptyId: 'pty-1',
          worktreeId: homeId,
          processIncarnation: 'pty-1:incarnation-1',
          paneKey: 'tab-1:leaf-1',
          launchTokenHash: 'hash-1',
          hostScope: { kind: 'local', hostId: 'local' }
        } as never)
      : null
  )
  const gitExecution = options.execution === 'git'
  vi.spyOn(runtime, 'showManagedTerminalWorkspace').mockImplementation(async (selector) => {
    if (selector === homeKey) {
      return {
        id: homeId,
        repoId: gitHome ? 'repo-home' : 'folder-workspace:group-1',
        path: '/workspace/home',
        hostId: 'local'
      } as never
    }
    if (gitExecution && selector === 'worktree:repo-1::/srv/repo') {
      return {
        id: 'repo-1::/srv/repo',
        repoId: 'repo-1',
        path: '/srv/repo',
        hostId: 'ssh:build'
      } as never
    }
    throw new Error(`selector_not_found:${selector}`)
  })
  vi.spyOn(runtime, 'showManagedWorktree').mockImplementation(async (selector) => {
    if (selector === `id:${homeId}`) {
      return { id: homeId, repoId: 'repo-home', path: '/workspace/home', hostId: 'local' } as never
    }
    return {
      id: 'repo-1::/srv/repo',
      repoId: 'repo-1',
      path: '/srv/repo',
      hostId: 'ssh:build'
    } as never
  })
  vi.spyOn(runtime, 'listRepos').mockReturnValue([
    { id: 'repo-home', path: '/workspace/home', connectionId: null } as never,
    { id: 'repo-1', path: '/srv/repo', connectionId: 'build' } as never
  ])
  vi.spyOn(runtime, 'getRuntimeGitStatus').mockResolvedValue({
    head: 'a'.repeat(40),
    entries: [{ path: 'src/index.ts' }]
  } as never)
  const context: RpcContext = {
    runtime,
    legacyCoordinatorRunId: run.id,
    legacyCoordinatorAuthority: {
      runId: run.id,
      principalId: 'coordinator-1',
      terminalHandle: 'coordinator-1',
      paneKey: 'tab-1:leaf-1',
      consumerGeneration: run.consumer_generation
    },
    clientCapabilities: options.clientCapabilities ?? [
      MAESTRO_COMPOSED_BOOTSTRAP_RUNTIME_CAPABILITY,
      WORKSPACE_BOOTSTRAP_GIT_HOME_RUNTIME_CAPABILITY,
      WORKSPACE_BOOTSTRAP_RECEIPT_V2_RUNTIME_CAPABILITY
    ]
  }
  const request = {
    schema_version: 1 as const,
    protocol: 'maestro-bootstrap/v1' as const,
    mutation: {
      mutation_id: 'bootstrap-1',
      execution_host_id: gitExecution ? 'ssh:build' : 'local',
      workspace_key: gitExecution ? 'worktree:repo-1::/srv/repo' : homeKey,
      run_id: run.id
    },
    coordinator_generation: run.consumer_generation
  }
  return { context, database, dispatch, request, run, runtime, task }
}

describe('Maestro composed bootstrap', () => {
  it.each(['local', 'remote'] as const)(
    'preserves a Git coordinator home when bootstrapping %s execution',
    async (execution) => {
      const { context, database, request, task } = harness({
        home: 'git',
        execution: execution === 'remote' ? 'git' : 'folder'
      })
      try {
        const receipt = await bootstrapMaestroProjection(context, request)
        const projection = getMaestroProjection.call(database, request.mutation)

        expect(receipt.workspace_scope).toMatchObject({
          orchestration_home: {
            execution_host_id: 'local',
            workspace_key: 'worktree:repo-home::/workspace/home',
            kind: 'git-worktree',
            path: '/workspace/home',
            worktree_path: '/workspace/home'
          },
          execution_workspace: { workspace_key: request.mutation.workspace_key },
          base_revision: 'a'.repeat(40),
          dirty_paths: ['src/index.ts']
        })
        expect(projection?.nodes).toContainEqual(
          expect.objectContaining({ type: 'attempt', taskId: task.id })
        )
        expect(await bootstrapMaestroProjection(context, request)).toMatchObject({
          outcome: 'replayed',
          workspace_scope: receipt.workspace_scope
        })
      } finally {
        database.close()
      }
    }
  )

  it('rejects Git home bootstrap and replay for clients without Git home support', async () => {
    const { context, database, request } = harness({ home: 'git' })
    const oldContext = {
      ...context,
      clientCapabilities: [
        MAESTRO_COMPOSED_BOOTSTRAP_RUNTIME_CAPABILITY,
        WORKSPACE_BOOTSTRAP_RECEIPT_V2_RUNTIME_CAPABILITY
      ]
    }
    try {
      await expect(bootstrapMaestroProjection(oldContext, request)).rejects.toMatchObject({
        code: 'update_required'
      })
      expect(getMaestroProjection.call(database, request.mutation)).toBeNull()
      await bootstrapMaestroProjection(context, request)
      await expect(bootstrapMaestroProjection(oldContext, request)).rejects.toMatchObject({
        code: 'update_required'
      })
    } finally {
      database.close()
    }
  })

  it('publishes folder revision zero from authoritative Run, Task, and Dispatch rows', async () => {
    const { context, database, dispatch, request, run, task } = harness()

    const receipt = await bootstrapMaestroProjection(context, request)
    const projection = getMaestroProjection.call(database, {
      execution_host_id: 'local',
      workspace_key: 'folder:home-1'
    })

    expect(receipt).toMatchObject({
      outcome: 'published',
      projection_revision: 0,
      mutation: request.mutation,
      workspace_scope: {
        run_id: run.id,
        base_revision: expect.stringMatching(/^folder-observation:/),
        dirty_paths: []
      }
    })
    expect(projection?.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: task.id, type: 'task', title: 'Projection worker' }),
        expect.objectContaining({ id: dispatch.id, type: 'attempt', taskId: task.id })
      ])
    )
    expect(context.runtime.showManagedTerminalWorkspace).toHaveBeenCalledWith('folder:home-1')
    database.close()
  })

  it('replays the same and equivalent mutation without issuing a new folder observation', async () => {
    const { context, database, request, runtime } = harness()
    const first = await bootstrapMaestroProjection(context, request)
    const second = await bootstrapMaestroProjection(context, request)
    const alias = await bootstrapMaestroProjection(context, {
      ...request,
      mutation: { ...request.mutation, mutation_id: 'bootstrap-2' }
    })

    expect(first.outcome).toBe('published')
    expect(second.outcome).toBe('replayed')
    expect(alias.outcome).toBe('replayed')
    expect(alias.workspace_scope.base_revision).toBe(first.workspace_scope.base_revision)
    expect(runtime.showManagedTerminalWorkspace).toHaveBeenCalledTimes(1)
    database.close()
  })

  it('bootstraps a remote Git execution workspace from its host-owned status', async () => {
    const { context, database, request, runtime } = harness({ execution: 'git' })

    const receipt = await bootstrapMaestroProjection(context, request)

    expect(receipt.workspace_scope).toMatchObject({
      execution_host: { id: 'ssh:build', boundary: 'remote' },
      orchestration_home: { workspace_key: 'folder:home-1' },
      execution_workspace: {
        workspace_key: 'worktree:repo-1::/srv/repo',
        worktree_path: '/srv/repo'
      },
      base_revision: 'a'.repeat(40),
      dirty_paths: ['src/index.ts']
    })
    expect(runtime.getRuntimeGitStatus).toHaveBeenCalledExactlyOnceWith('id:repo-1::/srv/repo')
    expect(runtime.showManagedTerminalWorkspace).toHaveBeenCalledWith('worktree:repo-1::/srv/repo')
    database.close()
  })

  it('fails mixed-version callers before reading or publishing workspace state', async () => {
    const { context, database, request, runtime } = harness({ clientCapabilities: [] })

    await expect(bootstrapMaestroProjection(context, request)).rejects.toMatchObject({
      code: 'update_required'
    })
    expect(runtime.showManagedTerminalWorkspace).not.toHaveBeenCalled()
    expect(
      getMaestroProjection.call(database, {
        execution_host_id: 'local',
        workspace_key: 'folder:home-1'
      })
    ).toBeNull()
    database.close()
  })
})
