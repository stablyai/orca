import type { MaestroDocumentReadScope } from '../../../../shared/maestro-contract'
import type { MaestroRunProgressV2 } from '../../../../shared/maestro-run-progress'
import type { getMaestroProjection } from '../../orchestration/db/maestro/maestro-projection-store'
import { isEquivalentPaneKey } from '../../orchestration/db/pane-key-match'
import type { RunRow } from '../../orchestration/types'
import type { RpcContext } from '../core'

export type RunProgressAuthority = {
  run: RunRow
  projection: ReturnType<typeof getMaestroProjection>
  recovered: boolean
  health: MaestroRunProgressV2['projection_health']
}

export function resolveRunProgressAuthority(
  database: ReturnType<RpcContext['runtime']['getOrchestrationDb']>,
  scope: MaestroDocumentReadScope,
  projection: ReturnType<typeof getMaestroProjection>,
  requestedRunId?: string
): RunProgressAuthority | null {
  const bound = currentManagedRun(database, scope, requestedRunId, projection?.runId)
  if (bound) {
    const currentProjection = projection?.runId === bound.id ? projection : null
    const projectionCurrent =
      currentProjection?.coordinator.generation === bound.consumer_generation
    if (projectionCurrent) {
      return {
        run: bound,
        projection: currentProjection,
        recovered: false,
        health: { state: 'healthy', revision: currentProjection.revision }
      }
    }
    const stale = currentProjection !== null
    return {
      run: bound,
      projection: currentProjection,
      recovered: true,
      health: {
        state: stale ? 'stale' : 'partial',
        revision: currentProjection?.revision ?? bound.consumer_generation,
        warning: stale
          ? 'Recovered current Run state from an authenticated newer coordinator generation.'
          : 'Recovered current Run state from its authenticated managed workspace binding.'
      }
    }
  }
  if (!projection) {
    return null
  }
  const run = database.getRun(projection.runId)
  if (!run) {
    return null
  }
  const current = projection.coordinator.generation === run.consumer_generation
  return {
    run,
    projection,
    recovered: false,
    health: current
      ? { state: 'healthy', revision: projection.revision }
      : {
          state: 'stale',
          revision: projection.revision,
          warning: 'Run projection is stale and current workspace authority is unverifiable.'
        }
  }
}

function currentManagedRun(
  database: ReturnType<RpcContext['runtime']['getOrchestrationDb']>,
  scope: MaestroDocumentReadScope,
  requestedRunId?: string,
  projectedRunId?: string
): RunRow | null {
  const bindingPredicate = projectedRunId
    ? 'leases.run_id = ?'
    : 'leases.execution_host_id = ? AND leases.workspace_key = ?'
  const bindingParameters = projectedRunId
    ? [projectedRunId]
    : [scope.execution_host_id, scope.workspace_key]
  const rows = database.db
    .prepare(
      `SELECT runs.*, leases.terminal_handle AS lease_terminal_handle,
              leases.pane_key AS lease_pane_key, leases.coordinator_generation
       FROM maestro_terminal_leases leases
       JOIN runs ON runs.id = leases.run_id
       WHERE ${bindingPredicate}
         AND leases.role = 'coordinator'
         AND leases.lifecycle_state NOT IN ('released', 'superseded', 'archived')
         AND (? IS NULL OR runs.id = ?)
       ORDER BY leases.updated_at DESC, leases.id DESC`
    )
    .all(...bindingParameters, requestedRunId ?? null, requestedRunId ?? null) as (RunRow & {
    lease_terminal_handle: string | null
    lease_pane_key: string | null
    coordinator_generation: number | null
  })[]
  const match = rows.find(
    (row) =>
      row.coordinator_generation === row.consumer_generation &&
      row.coordinator_handle !== null &&
      row.coordinator_pane_key !== null &&
      row.lease_terminal_handle === row.coordinator_handle &&
      row.lease_pane_key !== null &&
      isEquivalentPaneKey(row.lease_pane_key, row.coordinator_pane_key)
  )
  return match ?? null
}
