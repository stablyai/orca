import { z } from 'zod'
import type { RuntimeResourceHealth } from '../../../../shared/process-stats-types'
import {
  buildMaestroResourceInventory,
  SharedExecutionHostResourceCollector,
  type MaestroBrowserResource,
  type MaestroWorkerResource
} from '../../maestro-resource-inventory'
import {
  collectDaemonGenerationInventory,
  isDaemonGenerationProvider
} from '../../daemon-generation-inventory'
import {
  getWorktreeExecutionHostId,
  normalizeExecutionHostId,
  toSshExecutionHostId
} from '../../../../shared/execution-host'
import {
  folderWorkspaceKey,
  parseWorkspaceKey,
  worktreeWorkspaceKey
} from '../../../../shared/workspace-scope'
import { parseWorkerTerminalHostScope } from '../../orchestration/worker-terminal-process-liveness'
import { defineMethod, type RpcContext, type RpcMethod } from '../core'

const ResourceHealthParamsSchema = z
  .object({
    executionHostId: z.string().trim().min(1).max(256),
    workspaceKey: z.string().trim().min(1).max(2_048),
    visible: z.boolean().default(true)
  })
  .strict()

const collector = new SharedExecutionHostResourceCollector()

export async function collectRuntimeResourceHealth(
  params: z.infer<typeof ResourceHealthParamsSchema>,
  context: RpcContext,
  sharedCollector: SharedExecutionHostResourceCollector = collector
): Promise<RuntimeResourceHealth> {
  const scopeProven = await provesLocalWorkspaceScope(params, context).catch(() => false)
  if (!scopeProven) {
    return unverifiableScope(params)
  }
  return await sharedCollector.collect(
    {
      executionHostId: params.executionHostId,
      workspaceKey: params.workspaceKey,
      visible: params.visible
    },
    async () => {
      const provider = context.runtime.getLocalProvider()
      if (!isDaemonGenerationProvider(provider)) {
        throw new Error('daemon_generation_inventory_unavailable')
      }
      const [memory, daemonGenerations] = await Promise.all([
        context.runtime.getMemorySnapshot(),
        collectDaemonGenerationInventory(provider)
      ])
      const { workers, browserSurfaces } = readDurableResources(context, params)
      return buildMaestroResourceInventory({
        memory,
        daemonGenerations,
        workers,
        browserSurfaces
      })
    }
  )
}

export const RUNTIME_RESOURCE_HEALTH_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'runtime.resourceHealth',
    params: ResourceHealthParamsSchema,
    handler: collectRuntimeResourceHealth
  })
]

function readDurableResources(
  context: RpcContext,
  scope: Pick<z.infer<typeof ResourceHealthParamsSchema>, 'executionHostId' | 'workspaceKey'>
): {
  workers: MaestroWorkerResource[]
  browserSurfaces: MaestroBrowserResource[]
} {
  const database = context.runtime.getOrchestrationDb()
  const parsedWorkspace = parseWorkspaceKey(scope.workspaceKey)
  const expectedWorktreeId =
    parsedWorkspace?.type === 'worktree' ? parsedWorkspace.worktreeId : scope.workspaceKey
  const workers = database.listWorkerTerminalResources().filter((worker) => {
    const resource = worker.resource
    if (!resource || resource.worktree_id !== expectedWorktreeId) {
      return false
    }
    const host = parseWorkerTerminalHostScope(resource.host_scope)
    return host?.kind === 'local' && scope.executionHostId === 'local'
  })
  const browserSurfaces = database
    .listReconcilableMaestroBrowserSurfaces()
    .filter(
      (surface) =>
        surface.receipt.execution_host_id === scope.executionHostId &&
        surface.receipt.workspace_key === scope.workspaceKey
    )
  return {
    workers,
    browserSurfaces
  }
}

async function provesLocalWorkspaceScope(
  params: z.infer<typeof ResourceHealthParamsSchema>,
  context: RpcContext
): Promise<boolean> {
  if (params.executionHostId !== 'local') {
    return false
  }
  const parsed = parseWorkspaceKey(params.workspaceKey)
  if (parsed?.type === 'folder') {
    const folder = context.runtime
      .listFolderWorkspaces()
      .find((candidate) => folderWorkspaceKey(candidate.id) === params.workspaceKey)
    if (!folder) {
      return false
    }
    const host =
      normalizeExecutionHostId(folder.executionHostId) ??
      (folder.connectionId ? toSshExecutionHostId(folder.connectionId) : 'local')
    return host === 'local'
  }
  if (parsed?.type !== 'worktree') {
    return false
  }
  const [{ worktrees }, repos] = await Promise.all([
    context.runtime.listManagedWorktrees(),
    Promise.resolve(context.runtime.listRepos())
  ])
  const worktree = worktrees.find(
    (candidate) => worktreeWorkspaceKey(candidate.id) === params.workspaceKey
  )
  if (!worktree) {
    return false
  }
  const repo = repos.find((candidate) => candidate.id === worktree.repoId)
  return getWorktreeExecutionHostId(worktree, repo) === 'local'
}

function unverifiableScope(
  params: z.infer<typeof ResourceHealthParamsSchema>
): RuntimeResourceHealth {
  return {
    schemaVersion: 1,
    executionHostId: params.executionHostId,
    workspaceKey: params.workspaceKey,
    state: 'unverifiable',
    reason: 'The requested execution host and workspace could not be proven by this runtime.',
    collectedAt: null,
    hostMemoryUsagePercent: null,
    inventory: {
      daemonGenerations: [],
      workerIds: [],
      browserSurfaceIds: [],
      processRootPids: [],
      rendererCount: null,
      aggregateCpu: null,
      aggregateMemory: null
    }
  }
}
