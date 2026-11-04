import type { TerminalPaneLayoutNode } from '../../shared/terminal-tab-types'
import type { WorkspaceSurface } from '../../shared/workspace-surfaces/surface-content'
import type { SurfaceHostDomain } from '../../shared/workspace-surfaces/surface-profile-domain'

export type SurfaceMigrationEvidence = Pick<
  SurfaceHostDomain,
  'retainedReferences' | 'identityMappings'
>

/** Imported identities never displace an already committed resource or conversation. */
export function reserveImportedSurfaceIdentities(
  incoming: readonly WorkspaceSurface[],
  held: readonly WorkspaceSurface[],
  reservedTabIds: readonly string[],
  evidence: SurfaceMigrationEvidence,
  mintId: () => string
): WorkspaceSurface[] {
  const tabs = new Set(reservedTabIds)
  const entities = new Set<string>()
  const leaves = new Set<string>()
  const resources = new Set<string>()
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
      const mapped = evidence.identityMappings.find(
        (entry) =>
          entry.workspaceId === surface.workspaceId &&
          entry.kind === kind &&
          entry.previousId === previousId &&
          !used.has(entry.currentId)
      )
      if (used.has(currentId) && mapped) {
        currentId = mapped.currentId
      }
      while (used.has(currentId)) {
        currentId = mintId()
      }
      used.add(currentId)
      if (currentId !== previousId && currentId !== mapped?.currentId) {
        evidence.identityMappings.push({
          workspaceId: surface.workspaceId,
          kind,
          previousId,
          currentId
        })
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
          if (leaf.facts.ptyId && resources.has(leaf.facts.ptyId)) {
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
