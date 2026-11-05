import type { SurfaceTransactionChanges } from './surface-transaction-changes'
import { isDeepStrictEqual } from 'node:util'
import { SurfaceSessionProjectionCache } from '../../shared/workspace-surfaces/surface-session-projection-cache'
import type Database from '../sqlite/sync-database'
import {
  WORKSPACE_SURFACE_DOMAIN,
  emptySurfaceProfileDomain,
  surfaceProfileDomainSchema,
  type SurfaceProfileDomain,
  type SurfaceHostDomain
} from '../../shared/workspace-surfaces/surface-profile-domain'
import type { WorkspaceSurface } from '../../shared/workspace-surfaces/surface-content'
import type { SurfaceAllocation } from '../../shared/workspace-surfaces/surface-allocation'
import { validateProfileStateDocumentRow } from '../persistence/profile-state/profile-state-document-validation'

type HostIndex = {
  surfaces: ReadonlyMap<string, WorkspaceSurface>
  allocations: ReadonlyMap<string, SurfaceAllocation>
  runs: ReadonlyMap<string, { surface: WorkspaceSurface; leafId: string }>
  receipts: ReadonlyMap<string, SurfaceHostDomain['receipts'][number]>
}
export type SurfaceProfileSnapshot = {
  domain: SurfaceProfileDomain
  projections: ReadonlyMap<string, SurfaceSessionProjectionCache>
  revision: number
  contentHash: string | null
  payload: string | null
  hosts: ReadonlyMap<string, HostIndex>
}
type Entry = {
  snapshot: SurfaceProfileSnapshot
  dataVersion: number
  indexFingerprint: string | null
}
const committed = new WeakMap<Database.Database, Entry>()
const staged = new WeakMap<Database.Database, Entry>()

function indexFingerprint(db: Database.Database): string | null {
  if (
    !db
      .prepare("SELECT 1 FROM main.sqlite_schema WHERE name = 'workspace_surface_index_meta'")
      .get()
  ) {
    return null
  }
  const value = db
    .prepare('SELECT fingerprint FROM main.workspace_surface_index_meta WHERE singleton = 1')
    .get()?.fingerprint
  return typeof value === 'string' ? value : null
}
function dataVersion(db: Database.Database): number {
  return Number(db.prepare('PRAGMA main.data_version').get()?.data_version)
}
function stamp(db: Database.Database) {
  const row = db
    .prepare('SELECT revision, content_hash FROM main.profile_state_documents WHERE domain = ?')
    .get(WORKSPACE_SURFACE_DOMAIN)
  return {
    revision: row ? Number(row.revision) : 0,
    contentHash: row ? String(row.content_hash) : null
  }
}
function matches(
  entry: Entry,
  current: ReturnType<typeof stamp>,
  version: number,
  fingerprint: string | null
) {
  return (
    entry.snapshot.revision === current.revision &&
    entry.snapshot.contentHash === current.contentHash &&
    entry.dataVersion === version &&
    entry.indexFingerprint === fingerprint
  )
}
function snapshot(
  domain: SurfaceProfileDomain,
  revision: number,
  contentHash: string | null,
  payload: string | null,
  previous?: SurfaceProfileSnapshot,
  changes?: SurfaceTransactionChanges
): SurfaceProfileSnapshot {
  const hosts = new Map<string, HostIndex>()
  for (const [hostId, host] of Object.entries(domain.hosts)) {
    const prior = changes && previous?.hosts.get(hostId)
    if (prior) {
      const changedRows = changes!.surfaces.get(hostId)
      let surfaces = prior.surfaces
      let runs = prior.runs
      if (changedRows?.size) {
        const changedSurfaces = new Map(prior.surfaces)
        const changedRuns = new Map(prior.runs)
        for (const key of changedRows.keys()) {
          const old = prior.surfaces.get(key)
          if (old?.content?.kind === 'terminal') {
            for (const leaf of Object.values(old.content.leaves)) {
              changedRuns.delete(leaf.runId)
            }
          }
        }
        for (const [key, row] of changedRows) {
          const surface = row && structuredClone(row)
          if (!surface) {
            changedSurfaces.delete(key)
            continue
          }
          changedSurfaces.set(key, surface)
          if (surface.content?.kind === 'terminal') {
            for (const [leafId, leaf] of Object.entries(surface.content.leaves)) {
              if (changedRuns.has(leaf.runId)) {
                throw new Error('Duplicate surface run')
              }
              changedRuns.set(leaf.runId, { surface, leafId })
            }
          }
        }
        surfaces = changedSurfaces
        runs = changedRuns
      }
      hosts.set(hostId, {
        surfaces,
        runs,
        allocations: updateIndex(prior.allocations, changes!.allocations.get(hostId)),
        receipts: updateIndex(prior.receipts, changes!.receipts.get(hostId))
      })
      continue
    }
    const allocations = new Map<string, SurfaceAllocation>()
    for (const allocation of host.allocations) {
      if (allocations.has(allocation.allocationId)) {
        throw new Error('Duplicate surface allocation')
      }
      allocations.set(allocation.allocationId, allocation)
    }
    const receipts = new Map<string, SurfaceHostDomain['receipts'][number]>()
    for (const receipt of host.receipts) {
      const key = JSON.stringify([receipt.callerId, receipt.commandId])
      if (receipts.has(key)) {
        throw new Error('Duplicate surface receipt')
      }
      receipts.set(key, receipt)
    }
    const runs = new Map<string, { surface: WorkspaceSurface; leafId: string }>()
    for (const surface of host.surfaces) {
      if (surface.content?.kind !== 'terminal') {
        continue
      }
      for (const [leafId, leaf] of Object.entries(surface.content.leaves)) {
        if (runs.has(leaf.runId)) {
          throw new Error('Duplicate surface run')
        }
        runs.set(leaf.runId, { surface, leafId })
      }
    }
    hosts.set(hostId, {
      surfaces: new Map(
        host.surfaces.map((surface) => [
          JSON.stringify([surface.workspaceId, surface.hostTabId]),
          surface
        ])
      ),
      allocations,
      runs,
      receipts
    })
  }
  const projections =
    changes && previous
      ? new Map(previous.projections)
      : new Map<string, SurfaceSessionProjectionCache>()
  for (const [hostId, host] of changes && previous ? [] : Object.entries(domain.hosts)) {
    const prior = previous?.domain.hosts[hostId]
    projections.set(
      hostId,
      prior?.revision === host.revision && isDeepStrictEqual(prior.surfaces, host.surfaces)
        ? (previous!.projections.get(hostId) ?? new SurfaceSessionProjectionCache(host.surfaces))
        : new SurfaceSessionProjectionCache(host.surfaces)
    )
  }
  return { domain, revision, contentHash, payload, hosts, projections }
}

/** Connection-local committed values only; unrelated domain revisions do not invalidate the root. */
export function readSurfaceProfileSnapshot(db: Database.Database): SurfaceProfileSnapshot {
  const current = stamp(db)
  const version = dataVersion(db)
  const fingerprint = indexFingerprint(db)
  const prior = (db.isTransaction ? staged.get(db) : undefined) ?? committed.get(db)
  if (prior && matches(prior, current, version, fingerprint)) {
    return prior.snapshot
  }
  const row = db
    .prepare(
      'SELECT domain, payload, domain_version, revision, updated_at, content_hash FROM main.profile_state_documents WHERE domain = ?'
    )
    .get(WORKSPACE_SURFACE_DOMAIN)
  const document = row ? validateProfileStateDocumentRow(row, { retainParsedValue: true }) : null
  const value = snapshot(
    document ? surfaceProfileDomainSchema.parse(document.value) : emptySurfaceProfileDomain(),
    document?.revision ?? 0,
    document?.contentHash ?? null,
    document?.payload ?? null
  )
  const entry = { snapshot: value, dataVersion: version, indexFingerprint: fingerprint }
  if (db.isTransaction) {
    staged.set(db, entry)
  } else {
    committed.set(db, entry)
  }
  return value
}

/** The transaction owner calls this only after COMMIT, or discards it on every rollback. */
export function finishSurfaceProfileCache(db: Database.Database, accepted: boolean): void {
  const entry = staged.get(db)
  staged.delete(db)
  if (!accepted || db.isTransaction || !entry) {
    return
  }
  const current = stamp(db)
  if (entry.dataVersion !== dataVersion(db)) {
    return
  }
  if (
    entry.snapshot.revision === current.revision &&
    entry.snapshot.contentHash === current.contentHash
  ) {
    committed.set(db, {
      ...entry,
      dataVersion: dataVersion(db),
      indexFingerprint: indexFingerprint(db)
    })
  }
}

/** Known admitted after-image; its bytes/hash are the exact committed document, never normalized JSON. */
export function stageSurfaceProfileCache(
  db: Database.Database,
  domain: SurfaceProfileDomain,
  payload: string,
  changes?: SurfaceTransactionChanges
): void {
  const current = stamp(db)
  staged.set(db, {
    snapshot: snapshot(
      structuredClone(domain),
      current.revision,
      current.contentHash,
      payload,
      committed.get(db)?.snapshot,
      changes
    ),
    dataVersion: dataVersion(db),
    indexFingerprint: indexFingerprint(db)
  })
}

/** Publish a transaction's already-computed projections with its after-image, never before COMMIT. */
export function stageSurfaceProjections(
  db: Database.Database,
  projections: ReadonlyMap<string, SurfaceSessionProjectionCache>
): void {
  const entry = staged.get(db)
  if (!entry || !db.isTransaction) {
    throw new Error('Surface projections require the staged carrier')
  }
  staged.set(db, { ...entry, snapshot: { ...entry.snapshot, projections } })
}

function updateIndex<T>(
  before: ReadonlyMap<string, T>,
  changes?: ReadonlyMap<string, T | null>
): ReadonlyMap<string, T> {
  if (!changes?.size) {
    return before
  }
  const next = new Map(before)
  for (const [key, value] of changes) {
    if (value === null) {
      next.delete(key)
    } else {
      next.set(key, structuredClone(value))
    }
  }
  return next
}
