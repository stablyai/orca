import { z } from 'zod'
import type { MaestroBrowserSurfaceReceipt } from '../../../../shared/maestro-browser-surface'
import { MaestroDocumentReadScopeSchema } from '../../../../shared/maestro-contract'
import type { MaestroTerminalLease } from '../../../../shared/maestro-terminal-lease'
import { workspaceSurfaceKey } from '../../../../shared/maestro-workspace-canvas'
import type {
  MaestroRunProgress,
  MaestroRunProgressV2
} from '../../../../shared/maestro-run-progress'
import {
  MAESTRO_RUN_COMPLETION_RUNTIME_CAPABILITY,
  MAESTRO_RUN_PROGRESS_V2_RUNTIME_CAPABILITY
} from '../../../../shared/protocol-version'
import { projectMaestroRunProgress } from '../../orchestration/maestro-run-progress-projection'
import {
  getMaestroProjection,
  listMaestroProjectionIndexForScope
} from '../../orchestration/db/maestro/maestro-projection-store'
import {
  deserializeMaestroTerminalLease,
  type MaestroTerminalLeaseRow
} from '../../orchestration/db/maestro-terminal-lease/maestro-terminal-lease-row'
import {
  parseBrowserSurfaceRow,
  type BrowserSurfaceRow
} from '../../orchestration/db/maestro-browser-surface/maestro-browser-surface-record'
import type { DispatchContextRow, WorkerDispatchRow } from '../../orchestration/types'
import { projectNestedAgentActivities } from '../../orchestration/worker-provider-session'
import { exposeUtcTimestamp } from '../../orchestration/db/utc-timestamp'
import { defineMethod, type RpcContext, type RpcMethod } from '../core'
import { resolveMaestroDocumentReadScope } from '../maestro-principal'
import { workspaceCanvasSelector } from '../../services/maestro-workspace-canvas/maestro-workspace-surface-projection'
import { resolveRunProgressAuthority } from './maestro-run-progress-authority'
import { observeMaestroTerminalLiveness } from './maestro-run-progress-terminal-liveness'

const params = z
  .object({ scope: MaestroDocumentReadScopeSchema, runId: z.string().min(1).optional() })
  .strict()

type MaestroProjectionReadLabels = {
  documentRevision: number | null
  selectedRunId: string | null
  projectionRevisions: { runId: string; revision: number; updatedAt: string }[]
  projectionHealth: {
    state: 'healthy' | 'recovered' | 'stale' | 'empty'
    revision: number | null
  }
}

export type MaestroRunProgressResponse =
  | ({ schemaVersion: 2; progress: MaestroRunProgressV2 } & MaestroProjectionReadLabels)
  | { schemaVersion: 1; progress: MaestroRunProgress }
  | ({ schemaVersion: null; progress: null } & Partial<MaestroProjectionReadLabels>)

export async function readMaestroRunProgress(
  context: RpcContext,
  requestedScope: z.infer<typeof MaestroDocumentReadScopeSchema>,
  requestedRunId?: string
): Promise<MaestroRunProgressResponse> {
  const scope = await resolveMaestroDocumentReadScope(context, requestedScope)
  const database = context.runtime.getOrchestrationDb()
  const supportsV2 =
    context.clientCapabilities === undefined ||
    context.clientCapabilities.includes(MAESTRO_RUN_PROGRESS_V2_RUNTIME_CAPABILITY)
  const supportsCompletion =
    context.clientCapabilities === undefined ||
    context.clientCapabilities.includes(MAESTRO_RUN_COMPLETION_RUNTIME_CAPABILITY)
  const projection = getMaestroProjection.call(database, scope, requestedRunId)
  if (!supportsV2) {
    return projection
      ? { schemaVersion: 1, progress: projection.runProgress }
      : { schemaVersion: null, progress: null }
  }
  const authority = resolveRunProgressAuthority(database, scope, projection, requestedRunId)
  if (!authority) {
    return {
      schemaVersion: null,
      progress: null,
      ...projectionReadLabels(database, scope, null, null, 'empty')
    }
  }
  const { run } = authority
  const tasks = database.listTasks({ runId: run.id })
  const dispatches = database.db
    .prepare('SELECT * FROM dispatch_contexts WHERE run_id = ? ORDER BY created_at, id')
    .all(run.id) as DispatchContextRow[]
  const terminalLeases = (
    database.db
      .prepare(
        `SELECT * FROM maestro_terminal_leases
         WHERE run_id = ?
         ORDER BY created_at, id`
      )
      .all(run.id) as MaestroTerminalLeaseRow[]
  ).map(deserializeMaestroTerminalLease)
  const workerDispatches = database.db
    .prepare(
      `SELECT worker.* FROM worker_dispatches worker
       JOIN dispatch_contexts dispatch ON dispatch.id = worker.dispatch_id
       WHERE dispatch.run_id = ? ORDER BY worker.created_at, worker.dispatch_id`
    )
    .all(run.id) as WorkerDispatchRow[]
  const browserSurfaces = (
    database.db
      .prepare(
        `SELECT * FROM maestro_browser_surfaces
         WHERE run_id = ? ORDER BY created_at, surface_id`
      )
      .all(run.id) as BrowserSurfaceRow[]
  ).map((row) => parseBrowserSurfaceRow(row).receipt)
  const providerExecutions: {
    dispatchId: string
    session: NonNullable<ReturnType<RpcContext['runtime']['getExactWorkerProviderSession']>>
  }[] = []
  const nestedActivity = dispatches.flatMap((dispatch) => {
    if (!dispatch.assignee_handle) {
      return []
    }
    const observedAfter = Date.parse(
      exposeUtcTimestamp(dispatch.dispatched_at ?? dispatch.created_at) ?? ''
    )
    const session = context.runtime.getExactWorkerProviderSession(
      dispatch.assignee_handle,
      Number.isFinite(observedAfter) ? observedAfter : 0
    )
    if (session) {
      providerExecutions.push({ dispatchId: dispatch.id, session })
    }
    return session ? projectNestedAgentActivities({ dispatchId: dispatch.id, session }) : []
  })
  const [browserSurfaceKeys, terminalLiveness] = await Promise.all([
    readBrowserSurfaceKeys(context, scope, browserSurfaces),
    observeMaestroTerminalLiveness(context.runtime, database, terminalLeases)
  ])
  const projectionRevision = authority.projection?.revision ?? run.consumer_generation

  return {
    schemaVersion: 2,
    ...projectionReadLabels(
      database,
      scope,
      authority.projection,
      run.id,
      authority.recovered ? (authority.health.state === 'stale' ? 'stale' : 'recovered') : 'healthy'
    ),
    progress: projectMaestroRunProgress({
      run,
      tasks,
      dispatches,
      messages: database.getRunMailboxHistory(run.id, 512),
      terminalLeases,
      workerDispatches,
      browserSurfaces,
      providerExecutions,
      nestedActivity,
      executionHostId: scope.execution_host_id,
      workspaceKey: scope.workspace_key,
      revision: projectionRevision,
      projectionHealth: authority.health,
      cleanupHealth: projectCleanupHealth(terminalLeases),
      recoveredAuthority: authority.recovered,
      browserSurfaceKeys,
      terminalLiveness,
      completion: supportsCompletion ? database.getRunCompletion(run.id) : undefined
    })
  }
}

async function readBrowserSurfaceKeys(
  context: RpcContext,
  scope: z.infer<typeof MaestroDocumentReadScopeSchema>,
  browserSurfaces: readonly MaestroBrowserSurfaceReceipt[]
): Promise<Map<string, string>> {
  const scopes = new Map(
    [
      scope,
      ...browserSurfaces
        .filter((surface) => surface.execution_host_id === scope.execution_host_id)
        .map((surface) => ({
          execution_host_id: surface.execution_host_id,
          workspace_key: surface.workspace_key
        }))
    ].map((candidate) => [`${candidate.execution_host_id}\0${candidate.workspace_key}`, candidate])
  )
  const tabs = await Promise.all(
    [...scopes.values()].map(async (candidate) => {
      try {
        return {
          scope: candidate,
          tabs: (await context.runtime.listMobileSessionTabs(workspaceCanvasSelector(candidate)))
            .tabs
        }
      } catch {
        return { scope: candidate, tabs: [] }
      }
    })
  )
  return new Map(
    tabs.flatMap((entry) =>
      entry.tabs.flatMap((tab) =>
        tab.type === 'browser' && tab.browserPageId
          ? [
              [
                tab.browserPageId,
                workspaceSurfaceKey({
                  execution_host_id: entry.scope.execution_host_id,
                  workspace_key: entry.scope.workspace_key,
                  unified_tab_id: tab.id
                })
              ] as const
            ]
          : []
      )
    )
  )
}

function projectionReadLabels(
  database: ReturnType<RpcContext['runtime']['getOrchestrationDb']>,
  scope: z.infer<typeof MaestroDocumentReadScopeSchema>,
  selected: ReturnType<typeof getMaestroProjection>,
  selectedRunId: string | null = selected?.runId ?? null,
  state: MaestroProjectionReadLabels['projectionHealth']['state'] = selected ? 'healthy' : 'empty'
): MaestroProjectionReadLabels {
  const document = database.getMaestroDocument(scope)
  return {
    documentRevision: document.state === 'empty' ? null : document.revision,
    selectedRunId,
    projectionRevisions: listMaestroProjectionIndexForScope.call(database, scope).map((entry) => ({
      runId: entry.runId,
      revision: entry.revision,
      updatedAt: entry.updatedAt
    })),
    projectionHealth: {
      state,
      revision: selected?.revision ?? null
    }
  }
}

export function projectCleanupHealth(
  terminalLeases: readonly MaestroTerminalLease[]
): MaestroRunProgressV2['cleanup_health'] {
  const workerLeases = terminalLeases.filter((lease) => lease.role === 'worker')
  const unverifiable = workerLeases.filter(
    (lease) =>
      lease.lifecycleState === 'outcome_unknown' || lease.cleanupReceipt?.verdict === 'unverifiable'
  )
  if (unverifiable.length > 0) {
    return {
      state: 'unverifiable',
      count: unverifiable.length,
      warning: `Cleanup is unverifiable for ${unverifiable.length} worker resource${unverifiable.length === 1 ? '' : 's'}.`
    }
  }
  const pending = workerLeases.filter((lease) =>
    ['settled', 'retained', 'release_pending'].includes(lease.lifecycleState)
  )
  if (pending.length > 0) {
    return { state: 'pending', count: pending.length }
  }
  return { state: 'clean', count: 0 }
}

export const MAESTRO_RUN_PROGRESS_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'maestro.runProgress.get',
    params,
    handler: ({ scope, runId }, context) => readMaestroRunProgress(context, scope, runId)
  })
]
