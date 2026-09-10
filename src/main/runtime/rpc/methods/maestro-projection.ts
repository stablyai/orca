import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { MaestroBootstrapRequest } from '../../../../shared/maestro-bootstrap-contract'
import {
  AgentGraphViewSchema,
  type AgentGraphView,
  MaestroDocumentReadScopeSchema,
  MaestroWorkspaceAnchorSchema
} from '../../../../shared/maestro-contract'
import type { MaestroTerminalLease } from '../../../../shared/maestro-terminal-lease'
import { buildOrchestrationTaskDisplayMetadata } from '../../../../shared/orchestration-task-display'
import type { OrchestrationDb } from '../../orchestration/db/orchestration-db'
import { canConsumeMaestroIntent } from '../../../../shared/maestro-actor'
import {
  applyMaestroProjection,
  getMaestroProjection
} from '../../orchestration/db/maestro/maestro-projection-store'
import {
  deserializeMaestroTerminalLease,
  type MaestroTerminalLeaseRow
} from '../../orchestration/db/maestro-terminal-lease/maestro-terminal-lease-row'
import { OrchestrationError } from '../../orchestration/orchestration-error'
import type { DispatchContextRow, TaskRow } from '../../orchestration/types'
import { selectCurrentTaskDispatches } from '../../orchestration/maestro-current-task-dispatch'
import { defineMethod, type RpcMethod } from '../core'
import { resolveMaestroDocumentReadScope, resolveMaestroPrincipal } from '../maestro-principal'

const getParams = z.object({ scope: MaestroDocumentReadScopeSchema }).strict()
const applyParams = z
  .object({
    workspace: MaestroWorkspaceAnchorSchema,
    view: AgentGraphViewSchema
  })
  .strict()

function coordinatorId(handle: string, generation: number): string {
  const digest = createHash('sha256').update(handle).digest('hex').slice(0, 16)
  return `coordinator-${digest}-g${generation}`
}

function taskTitle(task: TaskRow): string {
  return (
    buildOrchestrationTaskDisplayMetadata({
      spec: task.spec,
      taskTitle: task.task_title,
      displayName: task.display_name
    }).displayName || 'Untitled task'
  )
}

function listDispatches(database: OrchestrationDb, runId: string): DispatchContextRow[] {
  return database.db
    .prepare('SELECT * FROM dispatch_contexts WHERE run_id = ? ORDER BY created_at, id')
    .all(runId) as DispatchContextRow[]
}

function listTerminalLeases(database: OrchestrationDb, runId: string): MaestroTerminalLease[] {
  return (
    database.db
      .prepare('SELECT * FROM maestro_terminal_leases WHERE run_id = ? ORDER BY created_at, id')
      .all(runId) as MaestroTerminalLeaseRow[]
  ).map(deserializeMaestroTerminalLease)
}

function parseDependencies(task: TaskRow): string[] {
  try {
    const value: unknown = JSON.parse(task.deps)
    return Array.isArray(value)
      ? value.filter((entry): entry is string => typeof entry === 'string')
      : []
  } catch {
    return []
  }
}

export function buildInitialMaestroProjection(
  database: OrchestrationDb,
  request: MaestroBootstrapRequest,
  workspaceScope: AgentGraphView['workspace_scope'],
  coordinatorHandle: string
): AgentGraphView {
  const tasks = database.listTasks({ runId: request.mutation.run_id })
  const taskIds = new Set(tasks.map((task) => task.id))
  const dispatches = selectCurrentTaskDispatches(
    tasks,
    listDispatches(database, request.mutation.run_id)
  )
  const leases = listTerminalLeases(database, request.mutation.run_id)
  const leaseByDispatch = new Map(
    leases
      .filter((lease) => lease.ownerPrincipal.startsWith('dispatch:'))
      .map((lease) => [lease.ownerPrincipal.slice('dispatch:'.length), lease])
  )
  const currentAttemptIds = new Set(
    dispatches.flatMap((dispatch) => {
      const attemptId = leaseByDispatch.get(dispatch.id)?.attemptId
      return attemptId ? [dispatch.id, attemptId] : [dispatch.id]
    })
  )
  const browserSurfaces = database
    .listReconcilableMaestroBrowserSurfaces()
    .filter(
      ({ receipt }) =>
        receipt.run_id === request.mutation.run_id &&
        receipt.execution_host_id === request.mutation.execution_host_id &&
        receipt.workspace_key === request.mutation.workspace_key
    )
  const nodes: AgentGraphView['nodes'] = tasks.map((task) => ({
    id: task.id,
    type: 'task',
    status: task.status,
    summary: taskTitle(task),
    task_id: task.id
  }))
  const edges: AgentGraphView['edges'] = []
  let edgeSequence = 0
  const addEdge = (
    type: AgentGraphView['edges'][number]['type'],
    sourceId: string,
    targetId: string
  ): void => {
    edgeSequence += 1
    edges.push({
      id: `bootstrap-edge-${edgeSequence}`,
      type,
      source_id: sourceId,
      target_id: targetId
    })
  }

  for (const task of tasks) {
    for (const dependencyId of parseDependencies(task)) {
      if (taskIds.has(dependencyId)) {
        addEdge('depends_on', task.id, dependencyId)
      }
    }
  }
  for (const dispatch of dispatches) {
    const task = tasks.find((candidate) => candidate.id === dispatch.task_id)
    const lease = leaseByDispatch.get(dispatch.id)
    nodes.push({
      id: dispatch.id,
      type: 'attempt',
      status: dispatch.status,
      summary: `${task ? taskTitle(task) : 'Untitled task'} attempt`,
      task_id: dispatch.task_id,
      ...(lease?.attemptId ? { attempt_id: lease.attemptId } : {}),
      ...(lease
        ? {
            profile: {
              requested: {
                agent: lease.launchProfile.agent,
                model: lease.launchProfile.model,
                effort: lease.launchProfile.effort
              },
              resolved: {
                agent: lease.launchProfile.agent,
                model: lease.launchProfile.model,
                effort: lease.launchProfile.effort
              },
              role: lease.role
            }
          }
        : {})
    })
    if (taskIds.has(dispatch.task_id)) {
      addEdge('reports_to', dispatch.id, dispatch.task_id)
    }
    if (!lease) {
      continue
    }
    nodes.push({
      id: lease.id,
      type: 'terminal-receipt',
      status: lease.lifecycleState,
      summary: lease.title,
      task_id: dispatch.task_id,
      ...(lease.attemptId ? { attempt_id: lease.attemptId } : {}),
      resource: {
        execution_host_id: lease.executionHostId,
        workspace_key: lease.workspaceKey,
        ...(lease.attemptId ? { attempt_id: lease.attemptId } : {}),
        terminal_id: lease.terminalHandle,
        terminal_status: lease.lifecycleState,
        ...(lease.cleanupReceipt ? { liveness: lease.cleanupReceipt.verdict } : {})
      }
    })
    addEdge('executes', dispatch.id, lease.id)
  }
  for (const { receipt } of browserSurfaces) {
    if (!currentAttemptIds.has(receipt.attempt_id)) {
      continue
    }
    nodes.push({
      id: receipt.surface_id,
      type: 'browser-surface',
      status: receipt.state,
      summary: receipt.title,
      task_id: receipt.task_id,
      attempt_id: receipt.attempt_id,
      resource: receipt
    })
    const dispatch = dispatches.find(
      (candidate) => leaseByDispatch.get(candidate.id)?.attemptId === receipt.attempt_id
    )
    if (dispatch) {
      addEdge('opens', dispatch.id, receipt.surface_id)
    }
  }

  const agents = [
    ...new Set(
      leases
        .map((lease) => lease.launchProfile.agent)
        .filter((agent): agent is NonNullable<typeof agent> => agent !== null)
    )
  ].slice(0, 32)
  const efforts = [
    ...new Set(
      leases
        .map((lease) => lease.launchProfile.effort)
        .filter(
          (effort): effort is 'low' | 'medium' | 'high' | 'xhigh' =>
            effort === 'low' || effort === 'medium' || effort === 'high' || effort === 'xhigh'
        )
    )
  ]
  return {
    schema_version: 1,
    protocol: 'agent-graph-view/v1',
    kind: 'snapshot',
    workspace_scope: workspaceScope,
    change: 'orchestration-run',
    run_id: request.mutation.run_id,
    coordinator: {
      id: coordinatorId(coordinatorHandle, request.coordinator_generation),
      generation: request.coordinator_generation
    },
    capabilities: {
      agents,
      efforts,
      placement_kinds: ['current-workspace', 'existing-workspace'],
      watch_deltas: true
    },
    nodes,
    edges,
    removed_node_ids: [],
    removed_edge_ids: [],
    revision: 0,
    cursor: null,
    from_cursor: null,
    reset_required: false,
    progress: undefined
  }
}

export const MAESTRO_PROJECTION_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'maestro.projection.get',
    params: getParams,
    handler: async ({ scope }, context) => {
      const resolved = await resolveMaestroDocumentReadScope(context, scope)
      return getMaestroProjection.call(context.runtime.getOrchestrationDb(), resolved)
    }
  }),
  defineMethod({
    name: 'maestro.projection.apply',
    params: applyParams,
    handler: async ({ workspace, view }, context) => {
      const principal = await resolveMaestroPrincipal(context, workspace)
      if (!canConsumeMaestroIntent(principal, workspace, view.coordinator.generation)) {
        throw new OrchestrationError(
          'unauthorized',
          'Only the current coordinator can publish an AgentGraphView.'
        )
      }
      try {
        return applyMaestroProjection.call(context.runtime.getOrchestrationDb(), workspace, view)
      } catch (error) {
        throw new OrchestrationError(
          'maestro_projection_rejected',
          error instanceof Error ? error.message : 'AgentGraphView projection was rejected.'
        )
      }
    }
  })
]
