import type {
  SurfaceStorageCommand,
  SurfaceCommittedChanges
} from '../../shared/workspace-surfaces/surface-storage-command'

import type {
  SurfaceProfileDomain,
  SurfaceHostDomain,
  SurfaceProjection
} from '../../shared/workspace-surfaces/surface-profile-domain'
import type Database from '../sqlite/sync-database'
import type { SurfaceKey, WorkspaceSurface } from '../../shared/workspace-surfaces/surface-content'
import type { SurfaceAllocation } from '../../shared/workspace-surfaces/surface-allocation'

export type SurfaceTransactionChanges = {
  surfaces: Map<string, Map<string, WorkspaceSurface | null>>
  allocations: Map<string, Map<string, SurfaceAllocation | null>>
  receipts: Map<string, Map<string, SurfaceHostDomain['receipts'][number] | null>>
  baselines: Map<string, Map<string, SurfaceProjection | null>>
  hosts: Map<string, { terminalInitialized: boolean; revision: number }>
  invalidated: Map<string, SurfaceKey>
}

const active = new WeakMap<Database.Database, SurfaceTransactionChanges>()
const keyOf = (key: SurfaceKey) => JSON.stringify([key.workspaceId, key.hostTabId])

/** Track admitted writes, including empty closes; replayed receipts execute no writes. */
export function trackSurfaceTransaction<T>(
  db: Database.Database,
  run: (changes: SurfaceTransactionChanges) => T
): T {
  if (!db.isTransaction || active.has(db)) {
    throw new Error('Surface change capture requires its owning transaction')
  }
  const changes: SurfaceTransactionChanges = {
    surfaces: new Map(),
    allocations: new Map(),
    receipts: new Map(),
    baselines: new Map(),
    hosts: new Map(),
    invalidated: new Map()
  }
  active.set(db, changes)
  try {
    return run(changes)
  } finally {
    active.delete(db)
  }
}

function record<T>(map: Map<string, Map<string, T>>, hostId: string, key: string, value: T) {
  const host = map.get(hostId) ?? new Map<string, T>()
  host.set(key, value)
  map.set(hostId, host)
}

export function recordSurfaceWrite(db: Database.Database, surface: WorkspaceSurface): void {
  const changes = active.get(db)
  if (changes) {
    record(changes.surfaces, surface.hostId, keyOf(surface), surface)
    invalidateSurfaceCapture(db, surface)
  }
}

export function recordSurfaceRemoval(db: Database.Database, key: SurfaceKey): void {
  const changes = active.get(db)
  if (changes) {
    record(changes.surfaces, key.hostId, keyOf(key), null)
  }
}

export function invalidateSurfaceCapture(db: Database.Database, key: SurfaceKey): void {
  active.get(db)?.invalidated.set(JSON.stringify([key.hostId, key.workspaceId, key.hostTabId]), {
    hostId: key.hostId,
    workspaceId: key.workspaceId,
    hostTabId: key.hostTabId
  })
}

export function recordSurfaceAllocation(
  db: Database.Database,
  hostId: string,
  id: string,
  value: SurfaceAllocation | null
): void {
  const changes = active.get(db)
  if (changes) {
    record(changes.allocations, hostId, id, value)
  }
}

export function recordSurfaceReceipt(
  db: Database.Database,
  hostId: string,
  callerId: string,
  commandId: string,
  value: SurfaceHostDomain['receipts'][number] | null
): void {
  const changes = active.get(db)
  if (changes) {
    record(changes.receipts, hostId, JSON.stringify([callerId, commandId]), value)
  }
}

export function recordSurfaceBaseline(
  db: Database.Database,
  hostId: string,
  workspaceId: string,
  value: SurfaceProjection | null
): void {
  const changes = active.get(db)
  if (changes) {
    record(changes.baselines, hostId, workspaceId, value)
  }
}

export function recordSurfaceHost(
  db: Database.Database,
  hostId: string,
  terminalInitialized: boolean,
  revision: number
): void {
  active.get(db)?.hosts.set(hostId, { terminalInitialized, revision })
}

export function reclaimEmptySurfaces(
  db: Database.Database,
  previous: SurfaceProfileDomain,
  transactionChanges: SurfaceTransactionChanges
): void {
  const reclaim = new Map<string, SurfaceKey>()
  for (const host of Object.values(previous.hosts)) {
    for (const surface of host.surfaces) {
      if (surface.content === null) {
        reclaim.set(
          JSON.stringify([surface.hostId, surface.workspaceId, surface.hostTabId]),
          surface
        )
      }
    }
  }
  for (const [hostId, changes] of transactionChanges.surfaces) {
    for (const [key, surface] of changes) {
      const encoded = JSON.stringify([hostId, ...JSON.parse(key)])
      if (surface?.content === null) {
        reclaim.set(encoded, surface)
      } else {
        reclaim.delete(encoded)
      }
    }
  }
  for (const key of reclaim.values()) {
    db.prepare(
      'DELETE FROM main.workspace_surfaces WHERE host_id = ? AND workspace_id = ? AND host_tab_id = ?'
    ).run(key.hostId, key.workspaceId, key.hostTabId)
    recordSurfaceRemoval(db, key)
  }
}

export function committedSurfaceChanges(
  hostIds: Iterable<string>,
  transactionChanges: SurfaceTransactionChanges
): Map<string, SurfaceCommittedChanges> {
  const changes = new Map<string, SurfaceCommittedChanges>()
  for (const hostId of hostIds) {
    const rows = transactionChanges.surfaces.get(hostId) ?? new Map()
    changes.set(hostId, {
      upserted: [...rows.values()].flatMap((surface) => (surface ? [surface] : [])),
      removed: [...rows].flatMap(([key, surface]) =>
        surface
          ? []
          : [
              {
                hostId,
                workspaceId: String(JSON.parse(key)[0]),
                hostTabId: String(JSON.parse(key)[1])
              }
            ]
      ),
      invalidated: [...transactionChanges.invalidated.values()].filter(
        (key) => key.hostId === hostId
      )
    })
  }
  return changes
}

export function resourceOnlySurfaceHosts(
  commands: readonly SurfaceStorageCommand[],
  hostIds: Iterable<string>,
  previous: SurfaceProfileDomain,
  next: SurfaceProfileDomain
): Set<string> {
  return new Set(
    [...hostIds].filter(
      (hostId) =>
        commands
          .filter((command) => command.hostId === hostId)
          .every((command) =>
            ['begin-run', 'bind-run', 'abort-run', 'acknowledge-run'].includes(command.type)
          ) && previous.hosts[hostId]?.revision === next.hosts[hostId]?.revision
    )
  )
}

export function cloneCommandSurfaceHosts(
  previous: SurfaceProfileDomain,
  next: SurfaceProfileDomain,
  commands: readonly SurfaceStorageCommand[]
): void {
  for (const hostId of new Set(commands.map((command) => command.hostId))) {
    const host = previous.hosts[hostId]
    if (host) {
      next.hosts[hostId] = {
        ...host,
        terminalBaselines: { ...host.terminalBaselines },
        retainedReferences: [...host.retainedReferences],
        identityMappings: [...host.identityMappings]
      }
    }
  }
}
