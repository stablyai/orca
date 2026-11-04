import type Database from '../sqlite/sync-database'
import {
  surfaceAllocationSchema,
  boundSurfaceRunAllocation,
  runTargetOf,
  type SurfaceAllocation
} from '../../shared/workspace-surfaces/surface-allocation'
import type { WorkspaceSurface } from '../../shared/workspace-surfaces/surface-content'
import { recordSurfaceAllocation } from './surface-transaction-changes'

export function readAllocation(
  db: Database.Database,
  hostId: string,
  allocationId: string
): SurfaceAllocation | null {
  const row = db
    .prepare(
      'SELECT row_json FROM main.workspace_surface_allocations WHERE host_id = ? AND allocation_id = ?'
    )
    .get(hostId, allocationId)
  if (!row) {
    return null
  }
  if (typeof row.row_json !== 'string') {
    throw new Error('surface_allocation_unreadable')
  }
  return surfaceAllocationSchema.parse(JSON.parse(row.row_json))
}

export function writeAllocation(db: Database.Database, input: SurfaceAllocation): void {
  const allocation = surfaceAllocationSchema.parse(input)
  const { target } = allocation
  db.prepare(`INSERT INTO main.workspace_surface_allocations
    (allocation_id, host_id, workspace_id, host_tab_id, leaf_id, row_json)
    VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(host_id, allocation_id)
    DO UPDATE SET workspace_id = excluded.workspace_id, host_tab_id = excluded.host_tab_id,
      leaf_id = excluded.leaf_id, row_json = excluded.row_json`).run(
    allocation.allocationId,
    target.hostId,
    target.workspaceId,
    target.hostTabId,
    target.leafId,
    JSON.stringify(allocation)
  )
  recordSurfaceAllocation(db, target.hostId, allocation.allocationId, allocation)
}

export function removeAllocation(
  db: Database.Database,
  hostId: string,
  allocationId: string
): void {
  db.prepare(
    'DELETE FROM main.workspace_surface_allocations WHERE host_id = ? AND allocation_id = ?'
  ).run(hostId, allocationId)
  recordSurfaceAllocation(db, hostId, allocationId, null)
}

/** A move transfers the obligation; removal/restart retires only the departed exact run. */
export function reconcileSurfaceAllocations(
  db: Database.Database,
  previous: readonly WorkspaceSurface[],
  changes: readonly WorkspaceSurface[]
): void {
  const successors = new Map(
    changes.flatMap((surface) =>
      surface.content?.kind === 'terminal'
        ? Object.entries(surface.content.leaves).map(
            ([leafId, leaf]) =>
              [leaf.runId, { target: runTargetOf(surface, leafId)!, leaf }] as const
          )
        : []
    )
  )
  for (const before of previous) {
    if (before.content?.kind !== 'terminal') {
      continue
    }
    for (const [leafId, leaf] of Object.entries(before.content.leaves)) {
      const allocation = readAllocation(db, before.hostId, leaf.runId)
      const successor = successors.get(leaf.runId)
      if (
        successor?.leaf.occurrence === leaf.occurrence &&
        (!leaf.facts.ptyId ||
          (successor.leaf.facts.ptyId === leaf.facts.ptyId &&
            successor.leaf.facts.incarnationId === leaf.facts.incarnationId))
      ) {
        if (allocation) {
          writeAllocation(db, { ...allocation, target: successor.target })
        }
        continue
      }
      if (allocation) {
        writeAllocation(db, { ...allocation, decision: 'aborting' })
      } else if (leaf.facts.ptyId) {
        writeAllocation(db, {
          ...boundSurfaceRunAllocation(before, leafId)!,
          decision: 'aborting'
        })
      }
    }
  }
}
