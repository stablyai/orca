import { randomUUID } from 'node:crypto'
import type { SurfaceProfileDomain } from '../../shared/workspace-surfaces/surface-profile-domain'
import {
  emptySurfaceHostDomain,
  emptySurfaceProfileDomain
} from '../../shared/workspace-surfaces/surface-profile-domain'
import type { WorkspaceSurface } from '../../shared/workspace-surfaces/surface-content'
import { runTargetOf } from '../../shared/workspace-surfaces/surface-allocation'
import { surfaceProjectionFingerprint } from '../workspace-surfaces/surface-legacy-projection'
import { surfaceDocumentMappingBuckets } from '../workspace-surfaces/surface-cold-evidence'
import { surfaceMappingPrefix } from '../../shared/workspace-surfaces/surface-evidence-document'
import {
  registerSurfaceMappingReader,
  reserveImportedSurfaceIdentities
} from '../workspace-surfaces/surface-migration-identities'
import { ownerKeyBelongsToRepo, rekeyOwnerKey } from './profile-project-worktree-identity'

/** A profile move changes placement, never the elected physical execution identity or decision. */
export function extractProjectSurfaces(
  domain: SurfaceProfileDomain | undefined,
  oldRepoId: string,
  newRepoId: string
): SurfaceProfileDomain | undefined {
  if (!domain) {
    return undefined
  }
  const moved = emptySurfaceProfileDomain()
  const belongs = (workspaceId: string) => ownerKeyBelongsToRepo(workspaceId, oldRepoId)
  const workspace = (workspaceId: string) =>
    rekeyOwnerKey(oldRepoId, newRepoId, workspaceId) ?? workspaceId
  const surface = (row: WorkspaceSurface): WorkspaceSurface => ({
    ...structuredClone(row),
    workspaceId: workspace(row.workspaceId)
  })
  for (const [hostId, host] of Object.entries(domain.hosts)) {
    const part = structuredClone(host)
    part.surfaces = host.surfaces.filter((row) => belongs(row.workspaceId)).map(surface)
    part.allocations = host.allocations
      .filter((row) => belongs(row.target.workspaceId))
      .map((row) => ({
        ...structuredClone(row),
        target: { ...row.target, workspaceId: workspace(row.target.workspaceId) }
      }))
    part.terminalBaselines = Object.fromEntries(
      Object.entries(host.terminalBaselines)
        .filter(([id]) => belongs(id))
        .map(([id, baseline]) => [
          workspace(id),
          { ...structuredClone(baseline), surfaces: baseline.surfaces.map(surface) }
        ])
    )
    part.retainedReferences = host.retainedReferences
      .filter((row) => belongs(row.workspaceId))
      .map((row) => ({ ...structuredClone(row), workspaceId: workspace(row.workspaceId) }))
    part.identityMappings = host.identityMappings
      .filter((row) => belongs(row.workspaceId))
      .map((row) => ({ ...row, workspaceId: workspace(row.workspaceId) }))
    part.receipts = []
    if (host.chatBaseline) {
      const surfaces = host.chatBaseline.surfaces
        .filter((row) => belongs(row.workspaceId))
        .map(surface)
      const tabs = new Set(surfaces.map((row) => row.hostTabId))
      part.chatBaseline = {
        ...structuredClone(host.chatBaseline),
        surfaces,
        tabs: host.chatBaseline.tabs.filter((row) => tabs.has(row.tabId))
      }
    }
    moved.hosts[hostId] = part
  }
  return moved
}

export function removeProjectSurfaces(
  domain: SurfaceProfileDomain | undefined,
  repoId: string
): SurfaceProfileDomain | undefined {
  if (!domain) {
    return undefined
  }
  const next = structuredClone(domain)
  const belongs = (workspaceId: string) => ownerKeyBelongsToRepo(workspaceId, repoId)
  for (const host of Object.values(next.hosts)) {
    host.surfaces = host.surfaces.filter((row) => !belongs(row.workspaceId))
    host.allocations = host.allocations.filter((row) => !belongs(row.target.workspaceId))
    host.terminalBaselines = Object.fromEntries(
      Object.entries(host.terminalBaselines).filter(([id]) => !belongs(id))
    )
    host.retainedReferences = host.retainedReferences.filter((row) => !belongs(row.workspaceId))
    host.identityMappings = host.identityMappings.filter((row) => !belongs(row.workspaceId))
    if (host.chatBaseline) {
      const removed = new Set(
        host.chatBaseline.surfaces
          .filter((row) => belongs(row.workspaceId))
          .map((row) => row.hostTabId)
      )
      host.chatBaseline.surfaces = host.chatBaseline.surfaces.filter(
        (row) => !belongs(row.workspaceId)
      )
      host.chatBaseline.tabs = host.chatBaseline.tabs.filter((row) => !removed.has(row.tabId))
    }
    host.revision++
  }
  return next
}

export type TransferredSurfaceIdentity = { before: WorkspaceSurface; after: WorkspaceSurface }

export function mergeProjectSurfaces(
  target: SurfaceProfileDomain | undefined,
  incoming: SurfaceProfileDomain,
  reservedTabs: (hostId: string) => readonly string[],
  coldDocuments: object = {}
): { domain: SurfaceProfileDomain; identities: Map<string, TransferredSurfaceIdentity[]> } {
  const domain = structuredClone(target ?? emptySurfaceProfileDomain())
  const identities = new Map<string, TransferredSurfaceIdentity[]>()
  const buckets = surfaceDocumentMappingBuckets(coldDocuments)
  for (const [hostId, part] of Object.entries(incoming.hosts)) {
    const host = domain.hosts[hostId] ?? emptySurfaceHostDomain()
    registerSurfaceMappingReader(
      host,
      (workspaceId, kind, previousId) =>
        buckets.get(surfaceMappingPrefix(hostId, workspaceId, kind, previousId)) ?? {
          entries: [],
          nextSequence: 0
        }
    )
    host.identityMappings.push(...structuredClone(part.identityMappings))
    host.retainedReferences.push(...structuredClone(part.retainedReferences))
    const accepted = reserveImportedSurfaceIdentities(
      part.surfaces,
      host.surfaces,
      reservedTabs(hostId),
      host,
      randomUUID,
      true
    )
    identities.set(
      hostId,
      part.surfaces.map((before, index) => ({ before, after: accepted[index]! }))
    )
    const targets = new Map(
      accepted.flatMap((surface) => {
        const content = surface.content
        return content?.kind === 'terminal'
          ? Object.entries(content.leaves).map(
              ([leafId, leaf]) => [leaf.runId, runTargetOf(surface, leafId)!] as const
            )
          : []
      })
    )
    host.surfaces.push(...accepted)
    host.allocations.push(
      ...part.allocations.map((allocation) => ({
        ...structuredClone(allocation),
        target: targets.get(allocation.allocationId) ?? structuredClone(allocation.target)
      }))
    )
    for (const [workspaceId, baseline] of Object.entries(part.terminalBaselines)) {
      const surfaces = accepted.filter(
        (row) => row.workspaceId === workspaceId && row.content?.kind === 'terminal'
      )
      host.terminalBaselines[workspaceId] = {
        ...structuredClone(baseline),
        surfaces,
        fingerprint: surfaceProjectionFingerprint(surfaces)
      }
    }
    host.terminalInitialized ||= part.terminalInitialized
    if (part.surfaces.some((row) => row.content?.kind === 'agent-session')) {
      host.chatInitialization = 'unknown'
    }
    host.revision = Math.max(host.revision, part.revision) + 1
    domain.hosts[hostId] = host
  }
  return { domain, identities }
}
