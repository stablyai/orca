import { isDeepStrictEqual } from 'node:util'
import type Database from '../sqlite/sync-database'
import {
  surfaceExecutionKernelChanged,
  type SurfaceExecutorIdentity
} from '../../shared/workspace-surfaces/surface-execution-provenance'
import {
  runLeafOf,
  runTargetOf,
  boundSurfaceRunAllocation,
  type SurfaceAllocation
} from '../../shared/workspace-surfaces/surface-allocation'
import { readAllocation, writeAllocation } from './surface-allocation-rows'
import { advanceDomain, readSurface, writeChanges } from './surface-rows'

/** The authenticated replacement observes its own kernel; it never acknowledges as the departed executor. */
export function retireSurfaceRunAfterKernelChange(
  db: Database.Database,
  subject: SurfaceAllocation,
  observer: SurfaceExecutorIdentity,
  mintId: () => string
): boolean {
  const surface = readSurface(db, subject.target)
  const allocation =
    readAllocation(db, subject.target.hostId, subject.allocationId) ??
    (surface ? boundSurfaceRunAllocation(surface, subject.target.leafId) : null)
  if (
    !allocation ||
    !isDeepStrictEqual(allocation, subject) ||
    !allocation.executorId ||
    observer.executorId === allocation.executorId ||
    !surfaceExecutionKernelChanged(allocation.provenance, observer.provenance)
  ) {
    return false
  }
  const leaf = runLeafOf(surface, allocation.target)
  if (surface?.content?.kind === 'terminal' && leaf) {
    if (
      leaf.executorId &&
      (leaf.executorId !== allocation.executorId ||
        !isDeepStrictEqual(leaf.provenance ?? null, allocation.provenance ?? null))
    ) {
      return false
    }
    const { ptyId: _ptyId, incarnationId: _incarnationId, ...facts } = leaf.facts
    const successor = {
      ...surface,
      revision: surface.revision + 1,
      content: {
        ...surface.content,
        leaves: {
          ...surface.content.leaves,
          [allocation.target.leafId]: { occurrence: leaf.occurrence, runId: mintId(), facts }
        }
      }
    }
    writeChanges(db, [successor])
    const target = runTargetOf(successor, allocation.target.leafId)!
    writeAllocation(db, {
      allocationId: target.runId,
      target,
      resourceId: null,
      executorId: null,
      provenance: null,
      resource: null,
      decision: 'pending',
      expiresAt: 0
    })
    advanceDomain(db, subject.target.hostId)
  }
  db.prepare(
    'DELETE FROM main.workspace_surface_allocations WHERE host_id = ? AND allocation_id = ?'
  ).run(subject.target.hostId, subject.allocationId)
  return true
}
