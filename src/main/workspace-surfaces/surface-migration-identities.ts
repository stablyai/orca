import type { TerminalPaneLayoutNode } from '../../shared/terminal-tab-types'
import type { WorkspaceSurface } from '../../shared/workspace-surfaces/surface-content'
import type { SurfaceHostDomain } from '../../shared/workspace-surfaces/surface-profile-domain'

export type SurfaceMigrationEvidence = Pick<
  SurfaceHostDomain,
  'retainedReferences' | 'identityMappings'
>

type Mapping = SurfaceHostDomain['identityMappings'][number]
export type SurfaceMappingBucket = { entries: Mapping[]; nextSequence: number }
const readers = new WeakMap<
  SurfaceMigrationEvidence,
  (workspaceId: string, kind: Mapping['kind'], previousId: string) => SurfaceMappingBucket
>()
export function registerSurfaceMappingReader(
  evidence: SurfaceMigrationEvidence,
  read: (workspaceId: string, kind: Mapping['kind'], previousId: string) => SurfaceMappingBucket
): void {
  readers.set(evidence, read)
}
export function readSurfaceMappings(
  evidence: SurfaceMigrationEvidence,
  workspaceId: string,
  kind: Mapping['kind'],
  previousId: string
): Mapping[] {
  return readSurfaceMappingBucket(evidence, workspaceId, kind, previousId).entries
}

export function readSurfaceMappingBucket(
  evidence: SurfaceMigrationEvidence,
  workspaceId: string,
  kind: Mapping['kind'],
  previousId: string
): SurfaceMappingBucket {
  return readers.get(evidence)?.(workspaceId, kind, previousId) ?? { entries: [], nextSequence: 0 }
}

/** Imported identities never displace an already committed resource or conversation. */
export function reserveImportedSurfaceIdentities(
  incoming: readonly WorkspaceSurface[],
  held: readonly WorkspaceSurface[],
  reservedTabIds: readonly string[],
  evidence: SurfaceMigrationEvidence,
  mintId: () => string,
  preservePhysicalResources = false
): WorkspaceSurface[] {
  const tabs = new Set(reservedTabIds)
  const entities = new Set<string>()
  const leaves = new Set<string>()
  const resources = new Set<string>()
  const mappings = new Map<
    string,
    { entries: typeof evidence.identityMappings; next: number; loaded?: boolean }
  >()
  const mappingKey = (workspaceId: string, kind: string, previousId: string): string =>
    JSON.stringify([workspaceId, kind, previousId])
  for (const entry of evidence.identityMappings) {
    const key = mappingKey(entry.workspaceId, entry.kind, entry.previousId)
    const bucket = mappings.get(key) ?? { entries: [], next: 0 }
    bucket.entries.push(entry)
    mappings.set(key, bucket)
  }
  const reserve = (surface: WorkspaceSurface): void => {
    if (surface.content) {
      tabs.add(surface.hostTabId)
    }
    if (surface.content?.kind === 'terminal') {
      entities.add(surface.content.entityId)
      for (const [id, leaf] of Object.entries(surface.content.leaves)) {
        leaves.add(id)
        if (leaf.facts.ptyId) {
          resources.add(leaf.facts.ptyId)
        }
      }
    }
  }
  held.forEach(reserve)
  return incoming.map((input) => {
    const surface = structuredClone(input)
    const rename = (
      kind: SurfaceHostDomain['identityMappings'][number]['kind'],
      previousId: string,
      used: Set<string>
    ): string => {
      let currentId = previousId
      const key = mappingKey(surface.workspaceId, kind, previousId)
      const bucket = mappings.get(key) ?? { entries: [], next: 0, loaded: false }
      if (used.has(currentId) && !bucket.loaded) {
        const cold = readSurfaceMappings(evidence, surface.workspaceId, kind, previousId)
        const known = new Set(cold.map((entry) => JSON.stringify(entry)))
        bucket.entries = [
          ...cold,
          ...bucket.entries.filter((entry) => !known.has(JSON.stringify(entry)))
        ]
        bucket.loaded = true
      }
      mappings.set(key, bucket)
      while (
        bucket.next < bucket.entries.length &&
        used.has(bucket.entries[bucket.next]!.currentId)
      ) {
        bucket.next++
      }
      const mapped = bucket.entries[bucket.next]
      if (used.has(currentId) && mapped) {
        currentId = mapped.currentId
      }
      while (used.has(currentId)) {
        currentId = mintId()
      }
      used.add(currentId)
      if (currentId !== previousId && currentId !== mapped?.currentId) {
        const entry = {
          workspaceId: surface.workspaceId,
          kind,
          previousId,
          currentId
        }
        evidence.identityMappings.push(entry)
        bucket.entries.push(entry)
        mappings.set(key, bucket)
      }
      return currentId
    }
    surface.hostTabId = rename('host-tab', surface.hostTabId, tabs)
    const content = surface.content
    if (content?.kind === 'terminal') {
      content.entityId = rename('terminal-entity', content.entityId, entities)
      const renamed = new Map<string, string>()
      content.leaves = Object.fromEntries(
        Object.entries(content.leaves).map(([id, leaf]) => {
          const nextId = rename('leaf', id, leaves)
          renamed.set(id, nextId)
          if (!preservePhysicalResources && leaf.facts.ptyId && resources.has(leaf.facts.ptyId)) {
            retainSurfaceReference(evidence, {
              workspaceId: input.workspaceId,
              kind: 'pane',
              id: `${input.hostTabId}:${id}`,
              raw: JSON.parse(
                JSON.stringify({
                  hostId: input.hostId,
                  workspaceId: input.workspaceId,
                  hostTabId: input.hostTabId,
                  entityId: input.content?.kind === 'terminal' ? input.content.entityId : null,
                  leafId: id,
                  facts: leaf.facts
                })
              )
            })
            delete leaf.facts.ptyId
            delete leaf.facts.incarnationId
          } else if (leaf.facts.ptyId) {
            resources.add(leaf.facts.ptyId)
          }
          return [nextId, leaf]
        })
      )
      content.root = renamePaneTree(content.root, renamed)
      if (content.chatLeafId) {
        content.chatLeafId = renamed.get(content.chatLeafId) ?? content.chatLeafId
      }
    }
    return surface
  })
}

export function retainSurfaceReference(
  evidence: SurfaceMigrationEvidence,
  reference: SurfaceHostDomain['retainedReferences'][number]
): void {
  const encoded = JSON.stringify(reference)
  if (!evidence.retainedReferences.some((entry) => JSON.stringify(entry) === encoded)) {
    evidence.retainedReferences.push(reference)
  }
}

function renamePaneTree(
  tree: TerminalPaneLayoutNode | null,
  renamed: ReadonlyMap<string, string>
): TerminalPaneLayoutNode | null {
  if (!tree) {
    return null
  }
  return tree.type === 'leaf'
    ? { ...tree, leafId: renamed.get(tree.leafId) ?? tree.leafId }
    : {
        ...tree,
        first: renamePaneTree(tree.first, renamed)!,
        second: renamePaneTree(tree.second, renamed)!
      }
}
