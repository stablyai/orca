import {
  emptySurfaceHostDomain,
  emptySurfaceProfileDomain,
  type SurfaceProfileDomain
} from '../../shared/workspace-surfaces/surface-profile-domain'
import {
  runLeafOf,
  type SurfaceAllocation
} from '../../shared/workspace-surfaces/surface-allocation'
import { retainSurfaceReference } from './surface-migration-identities'

/** Recovery selects content; it cannot revoke work admitted after the selected snapshot. */
export function preserveSurfaceRecoveryObligations(
  selected: SurfaceProfileDomain | undefined,
  later: SurfaceProfileDomain | undefined
): SurfaceProfileDomain | undefined {
  if (!selected && !later) {
    return undefined
  }
  const restored = structuredClone(selected ?? emptySurfaceProfileDomain())
  const hosts = new Set([...Object.keys(restored.hosts), ...Object.keys(later?.hosts ?? {})])
  for (const hostId of hosts) {
    const host = (restored.hosts[hostId] ??= emptySurfaceHostDomain())
    const newer = later?.hosts[hostId]
    const obligations = new Map(
      host.allocations.map((allocation) => [allocation.allocationId, allocation])
    )
    for (const allocation of newer?.allocations ?? []) {
      obligations.set(allocation.allocationId, structuredClone(allocation))
    }
    host.allocations = [...obligations.values()].map((allocation): SurfaceAllocation => {
      const surface = host.surfaces.find(
        (candidate) =>
          candidate.workspaceId === allocation.target.workspaceId &&
          candidate.hostTabId === allocation.target.hostTabId
      )
      const leaf = runLeafOf(surface ?? null, allocation.target)
      const resource = allocation.resource
      // A restored pending request must not redispatch old work. A new start gets a new run.
      const retained =
        allocation.decision === 'committed' &&
        leaf &&
        resource &&
        leaf.facts.ptyId === resource.ptyId &&
        leaf.facts.incarnationId === resource.incarnationId
      return retained ? allocation : { ...allocation, decision: 'aborting' }
    })
    const receipts = new Map(
      host.receipts.map((receipt) => [
        JSON.stringify([receipt.callerId, receipt.commandId]),
        receipt
      ])
    )
    for (const receipt of newer?.receipts ?? []) {
      receipts.set(JSON.stringify([receipt.callerId, receipt.commandId]), structuredClone(receipt))
    }
    host.receipts = [...receipts.values()]
    for (const reference of newer?.retainedReferences ?? []) {
      retainSurfaceReference(host, structuredClone(reference))
    }
    const mappings = new Set(host.identityMappings.map((mapping) => JSON.stringify(mapping)))
    for (const mapping of newer?.identityMappings ?? []) {
      if (!mappings.has(JSON.stringify(mapping))) {
        host.identityMappings.push(structuredClone(mapping))
        mappings.add(JSON.stringify(mapping))
      }
    }
    // Restoring one profile file says nothing about the journal's independently observed image.
    host.chatInitialization = 'unknown'
  }
  return restored
}
