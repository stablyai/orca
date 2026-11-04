import { isDeepStrictEqual } from 'node:util'
import { readProfileStateDomain } from '../persistence/profile-state/profile-state-domain-reader'
import {
  WORKSPACE_SURFACE_DOMAIN,
  surfaceProfileDomainSchema
} from '../../shared/workspace-surfaces/surface-profile-domain'
import { runLeafOf, runTargetOf } from '../../shared/workspace-surfaces/surface-allocation'
import type {
  SurfaceExecutorAdmission,
  SurfaceExecutorIntent
} from '../../shared/workspace-surfaces/surface-executor-contract'

/** Executor workers read the same carrier; missing or damaged storage never authorizes a fork. */
export function readSurfaceExecutorIntent(
  admission: SurfaceExecutorAdmission
): SurfaceExecutorIntent {
  const read = readProfileStateDomain(
    admission.scope.databasePath,
    admission.scope.profileId,
    WORKSPACE_SURFACE_DOMAIN
  )
  if (read.kind !== 'value') {
    return { kind: 'unreadable' }
  }
  const parsed = surfaceProfileDomainSchema.safeParse(read.value)
  if (!parsed.success) {
    return { kind: 'unreadable' }
  }
  const host = parsed.data.hosts[admission.hostId]
  if (!host?.terminalInitialized) {
    return { kind: 'unreadable' }
  }
  const allocations = host.allocations.filter(
    (entry) => entry.allocationId === admission.allocationId
  )
  if (allocations.length > 1) {
    return { kind: 'unreadable' }
  }
  const allocation = allocations[0]
  if (allocation) {
    if (
      allocation.resourceId !== admission.resourceId ||
      allocation.executorId !== admission.executorId ||
      !isDeepStrictEqual(allocation.provenance ?? null, admission.provenance ?? null) ||
      allocation.target.runId !== allocation.allocationId ||
      allocation.target.hostId !== admission.hostId
    ) {
      return { kind: 'unreadable' }
    }
    if (allocation.decision === 'pending') {
      const surfaces = host.surfaces.filter(
        (surface) =>
          surface.workspaceId === allocation.target.workspaceId &&
          surface.hostTabId === allocation.target.hostTabId
      )
      if (surfaces.length !== 1 || !runLeafOf(surfaces[0]!, allocation.target)) {
        return { kind: 'unreadable' }
      }
    }
    return { kind: 'allocation', allocation }
  }
  for (const surface of host.surfaces) {
    if (surface.content?.kind !== 'terminal') {
      continue
    }
    for (const [leafId, leaf] of Object.entries(surface.content.leaves)) {
      if (
        leaf.runId === admission.allocationId &&
        leaf.executorId === admission.executorId &&
        isDeepStrictEqual(leaf.provenance ?? null, admission.provenance ?? null) &&
        leaf.facts.ptyId === admission.resourceId
      ) {
        return {
          kind: 'bound',
          target: runTargetOf(surface, leafId)!,
          resource: {
            ptyId: admission.resourceId,
            ...(leaf.facts.incarnationId ? { incarnationId: leaf.facts.incarnationId } : {})
          }
        }
      }
    }
  }
  return { kind: 'absent' }
}
