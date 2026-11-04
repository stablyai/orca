import type Database from '../sqlite/sync-database'
import type { ExecutionHostId } from '../../shared/execution-host'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import type { SurfaceHostDomain } from '../../shared/workspace-surfaces/surface-profile-domain'
import type {
  TerminalSurfaceContent,
  WorkspaceSurface
} from '../../shared/workspace-surfaces/surface-content'
import { seedWorkspaceSurfaces } from './surface-migration'
import { reserveImportedSurfaceIdentities } from './surface-migration-identities'
import { surfaceProjectionFingerprint } from './surface-legacy-projection'
import { advanceDomain, readSurface, rowKey, writeChanges } from './surface-rows'

/** Old executables edit compatibility output; import only the delta against its exact exported occurrence. */
export function reconcileLegacyTerminalSurfaces(
  db: Database.Database,
  hostId: ExecutionHostId,
  session: WorkspaceSessionState,
  host: SurfaceHostDomain,
  mintId: () => string
): void {
  const incoming = seedWorkspaceSurfaces(hostId, session, [], mintId, host, false).filter(
    (surface) => surface.content?.kind === 'terminal'
  )
  const baseline = Object.values(host.terminalBaselines)
    .flatMap((projection) => projection.surfaces)
    .filter((surface) => surface.content?.kind === 'terminal')
  const incomingByTab = new Map(incoming.map((surface) => [surface.hostTabId, surface]))
  const consumed = new Set<WorkspaceSurface>()
  const changes = new Map<string, WorkspaceSurface>()
  const imports: WorkspaceSurface[] = []
  for (const before of baseline) {
    const next = incomingByTab.get(before.hostTabId)
    if (next) {
      consumed.add(next)
    }
    if (next?.workspaceId === before.workspaceId && sameLegacyContent(before, next)) {
      continue
    }
    const current = readSurface(db, before)
    if (!sameExportedOccurrence(before, current)) {
      // A hide in an older image cannot close a newer terminal or native successor.
      if (next && !sameLegacyContent(before, next)) {
        imports.push(next)
      }
      continue
    }
    changes.set(rowKey(before), {
      ...current,
      content: null,
      occurrence: mintId(),
      revision: current.revision + 1
    })
    if (next) {
      imports.push({
        ...next,
        occurrence: next.workspaceId === current.workspaceId ? current.occurrence : mintId(),
        revision: current.revision + 1,
        content: retainImportedRuns(before, next)
      })
    }
  }
  imports.push(...incoming.filter((surface) => !consumed.has(surface)))
  if (changes.size === 0 && imports.length === 0) {
    return
  }
  const held = host.surfaces.filter((surface) => surface.content && !changes.has(rowKey(surface)))
  const reservedTabs = Object.values(session.unifiedTabs ?? {}).flatMap((tabs) =>
    tabs
      .filter((tab) => tab.contentType !== 'terminal' && tab.contentType !== 'agent-session')
      .map((tab) => tab.id)
  )
  const accepted = reserveImportedSurfaceIdentities(imports, held, reservedTabs, host, mintId)
  for (const imported of accepted) {
    const previous = readSurface(db, imported)
    changes.set(rowKey(imported), {
      ...imported,
      revision: Math.max(imported.revision, (previous?.revision ?? 0) + 1)
    })
  }
  writeChanges(db, [...changes.values()])
  advanceDomain(db, hostId)
}

function sameLegacyContent(a: WorkspaceSurface, b: WorkspaceSurface): boolean {
  return surfaceProjectionFingerprint([a]) === surfaceProjectionFingerprint([b])
}

function sameExportedOccurrence(
  baseline: WorkspaceSurface,
  current: WorkspaceSurface | null
): current is WorkspaceSurface {
  return (
    current !== null &&
    current.occurrence === baseline.occurrence &&
    current.revision === baseline.revision &&
    current.content?.kind === 'terminal'
  )
}

function retainImportedRuns(
  before: WorkspaceSurface,
  incoming: WorkspaceSurface
): TerminalSurfaceContent {
  if (before.content?.kind !== 'terminal' || incoming.content?.kind !== 'terminal') {
    throw new Error('Terminal reconciliation requires terminal content')
  }
  const previous = before.content
  const next = incoming.content
  return {
    ...next,
    leaves: Object.fromEntries(
      Object.entries(next.leaves).map(([id, leaf]) => {
        const prior = previous.entityId === next.entityId ? previous.leaves[id] : undefined
        return [
          id,
          prior &&
          prior.facts.ptyId === leaf.facts.ptyId &&
          prior.facts.incarnationId === leaf.facts.incarnationId
            ? {
                ...leaf,
                occurrence: prior.occurrence,
                runId: prior.runId,
                ...(prior.executorId ? { executorId: prior.executorId } : {}),
                ...(prior.provenance ? { provenance: prior.provenance } : {})
              }
            : leaf
        ]
      })
    )
  }
}
