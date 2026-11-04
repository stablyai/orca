import type { SurfaceExecutionProvenance } from '../../shared/workspace-surfaces/surface-execution-provenance'
import { isDeepStrictEqual } from 'node:util'
import type { WorkspaceSurfaceDatabase } from './surface-database'
import { readSurface, writeChanges, advanceDomain } from './surface-rows'
import {
  runLeafOf,
  runTargetOf,
  sameRunTarget,
  surfaceResourceSchema,
  type SurfaceAllocation,
  type SurfaceAllocationAcknowledgment,
  type SurfaceAllocationOutcome,
  type SurfaceResource,
  type SurfaceRunTarget
} from '../../shared/workspace-surfaces/surface-allocation'
import { readAllocation, writeAllocation, removeAllocation } from './surface-allocation-rows'
import { conflictingSurfaceIdentity } from './surface-identities'

export class SurfaceRunRepository {
  constructor(private readonly storage: WorkspaceSurfaceDatabase) {}

  allocations(hostId: string): SurfaceAllocation[] {
    return this.storage.db
      .prepare('SELECT allocation_id FROM main.workspace_surface_allocations WHERE host_id = ?')
      .all(hostId)
      .map((row) => readAllocation(this.storage.db, hostId, String(row.allocation_id))!)
  }

  /** Claim the command's durable intent before dispatch; retries keep its original executor identity. */
  beginRun(
    target: SurfaceRunTarget,
    resourceId: string,
    executorId?: string,
    provenance?: SurfaceExecutionProvenance | null
  ): SurfaceAllocationOutcome {
    this.writable()
    return this.storage.transaction((db) => {
      const existing = readAllocation(db, target.hostId, target.runId)
      if (!existing || !sameRunTarget(existing.target, target)) {
        return { status: 'conflict', code: 'allocation_changed' }
      }
      if (existing.decision !== 'pending' || existing.resourceId !== null) {
        return { status: 'accepted', allocation: existing }
      }
      const leaf = runLeafOf(readSurface(db, target), target)
      if (!leaf || leaf.facts.ptyId) {
        return { status: 'conflict', code: 'pane_changed' }
      }
      const allocation: SurfaceAllocation = {
        ...existing,
        resourceId,
        executorId: executorId ?? null,
        provenance: provenance ?? null
      }
      writeAllocation(db, allocation)
      return { status: 'accepted', allocation }
    })
  }

  /** A closed or superseded pane records abort, even when the process result arrives afterward. */
  bindRun(hostId: string, allocationId: string, input: SurfaceResource): SurfaceAllocationOutcome {
    this.writable()
    const resource = surfaceResourceSchema.parse(input)
    return this.storage.transaction((db) => {
      const allocation = readAllocation(db, hostId, allocationId)
      if (!allocation) {
        const row = db
          .prepare(
            'SELECT workspace_id, host_tab_id, leaf_id FROM main.workspace_surface_leaves WHERE host_id = ? AND run_id = ?'
          )
          .get(hostId, allocationId)
        const surface = row
          ? readSurface(db, {
              hostId,
              workspaceId: String(row.workspace_id),
              hostTabId: String(row.host_tab_id)
            })
          : null
        const leafId = row ? String(row.leaf_id) : ''
        const leaf =
          surface?.content?.kind === 'terminal' ? surface.content.leaves[leafId] : undefined
        if (
          !surface ||
          !leaf ||
          leaf.runId !== allocationId ||
          leaf.facts.ptyId !== resource.ptyId ||
          leaf.facts.incarnationId !== resource.incarnationId
        ) {
          return { status: 'conflict', code: 'allocation_changed' }
        }
        // Adoption acknowledgment retires delivery work, not the current binding's replay identity.
        return {
          status: 'accepted',
          allocation: {
            allocationId,
            target: runTargetOf(surface, leafId)!,
            resourceId: resource.ptyId,
            executorId: leaf.executorId ?? null,
            provenance: leaf.provenance ?? null,
            expiresAt: 0,
            resource,
            decision: 'committed'
          }
        }
      }
      if (
        allocation.resourceId !== resource.ptyId ||
        (allocation.resource && !isDeepStrictEqual(allocation.resource, resource))
      ) {
        return { status: 'conflict', code: 'allocation_changed' }
      }
      const current = readSurface(db, allocation.target)
      const leaf = runLeafOf(current, allocation.target)
      if (allocation.decision === 'aborting' || !leaf) {
        const aborted: SurfaceAllocation = { ...allocation, resource, decision: 'aborting' }
        writeAllocation(db, aborted)
        return { status: 'accepted', allocation: aborted }
      }
      if (
        leaf.facts.ptyId &&
        (leaf.facts.ptyId !== resource.ptyId || leaf.facts.incarnationId !== resource.incarnationId)
      ) {
        return { status: 'conflict', code: 'pane_changed' }
      }
      if (allocation.decision === 'committed') {
        return { status: 'accepted', allocation }
      }
      if (!current || current.content?.kind !== 'terminal') {
        throw new Error('surface_run_content_changed')
      }
      const bound = {
        ...current,
        revision: current.revision + 1,
        content: {
          ...current.content,
          leaves: {
            ...current.content.leaves,
            [allocation.target.leafId]: {
              ...leaf,
              ...(allocation.executorId ? { executorId: allocation.executorId } : {}),
              ...(allocation.provenance ? { provenance: allocation.provenance } : {}),
              facts: { ...leaf.facts, ...resource }
            }
          }
        }
      }
      if (conflictingSurfaceIdentity(db, [bound])) {
        return { status: 'conflict', code: 'pane_changed' }
      }
      writeChanges(db, [bound])
      advanceDomain(db, hostId)
      const committed: SurfaceAllocation = { ...allocation, resource, decision: 'committed' }
      writeAllocation(db, committed)
      return { status: 'accepted', allocation: committed }
    })
  }

  abortRun(hostId: string, allocationId: string): SurfaceAllocation | null {
    this.writable()
    return this.storage.transaction((db) => {
      const allocation = readAllocation(db, hostId, allocationId)
      if (!allocation) {
        return null
      }
      const aborted: SurfaceAllocation = { ...allocation, decision: 'aborting' }
      writeAllocation(db, aborted)
      return aborted
    })
  }

  /** Only an executor's exact adoption/cancellation acknowledgment retires this obligation. */
  acknowledgeRun(acknowledgment: SurfaceAllocationAcknowledgment): boolean {
    this.writable()
    return this.storage.transaction((db) => {
      const allocation = readAllocation(db, acknowledgment.hostId, acknowledgment.allocationId)
      if (!allocation) {
        return true
      }
      if (allocation.executorId && acknowledgment.executorId !== allocation.executorId) {
        return false
      }
      if (allocation.decision !== acknowledgment.decision) {
        return false
      }
      if (acknowledgment.decision === 'committed') {
        const leaf = runLeafOf(readSurface(db, allocation.target), allocation.target)
        if (!leaf || !isDeepStrictEqual(allocation.resource, acknowledgment.resource)) {
          return false
        }
      }
      removeAllocation(db, acknowledgment.hostId, acknowledgment.allocationId)
      return true
    })
  }

  private writable(): void {
    if (this.storage.readOnly) {
      throw new Error('surface_store_read_only')
    }
  }
}
