import { readSurfaceProfileSnapshot } from './surface-profile-cache'
import { createHash } from 'node:crypto'
import type Database from '../sqlite/sync-database'
import {
  emptySurfaceHostDomain,
  surfaceCommandReceiptSchema,
  surfaceProfileDomainSchema,
  surfaceProjectionSchema,
  type SurfaceProfileDomain
} from '../../shared/workspace-surfaces/surface-profile-domain'
import { surfaceAllocationSchema } from '../../shared/workspace-surfaces/surface-allocation'
import { surfaceCommandOutcomeSchema } from '../../shared/workspace-surfaces/surface-command'
import { ensureWorkspaceSurfaceTables } from './surface-tables'
import { parseJson, parseSurface, writeSurface } from './surface-rows'
import { writeAllocation } from './surface-allocation-rows'
import type { SurfaceTransactionChanges } from './surface-transaction-changes'

export function readSurfaceProfileDomain(db: Database.Database): SurfaceProfileDomain {
  return structuredClone(readSurfaceProfileSnapshot(db).domain)
}

export function surfaceDomainFingerprint(payload: string): string {
  return createHash('sha256').update(payload).digest('hex')
}

/** Cache validity is committed beside its root document; an old JSON rebuild has no such cache. */
export function restoreSurfaceIndices(
  db: Database.Database,
  domain: SurfaceProfileDomain,
  fingerprint: string
): void {
  requireTransaction(db)
  ensureWorkspaceSurfaceTables(db)
  if (
    db
      .prepare('SELECT fingerprint FROM main.workspace_surface_index_meta WHERE singleton = 1')
      .get()?.fingerprint === fingerprint
  ) {
    return
  }
  db.exec(`DELETE FROM main.workspace_surface_domains;
    DELETE FROM main.workspace_surfaces;
    DELETE FROM main.workspace_surface_leaves;
    DELETE FROM main.workspace_surface_commands;
    DELETE FROM main.workspace_surface_allocations;
    DELETE FROM main.workspace_surface_projections`)
  for (const [hostId, host] of Object.entries(domain.hosts)) {
    db.prepare(`INSERT INTO main.workspace_surface_domains(host_id, initialized, revision)
      VALUES (?, ?, ?)`).run(hostId, Number(host.terminalInitialized), host.revision)
    for (const surface of host.surfaces) {
      writeSurface(db, surface)
    }
    for (const allocation of host.allocations) {
      writeAllocation(db, allocation)
    }
    for (const receipt of host.receipts) {
      db.prepare(`INSERT INTO main.workspace_surface_commands
        (host_id, caller_id, command_id, fingerprint, expires_at, result_json)
        VALUES (?, ?, ?, ?, ?, ?)`).run(
        hostId,
        receipt.callerId,
        receipt.commandId,
        receipt.fingerprint,
        receipt.expiresAt,
        JSON.stringify(receipt.outcome)
      )
    }
    for (const [workspaceId, baseline] of Object.entries(host.terminalBaselines)) {
      db.prepare(`INSERT INTO main.workspace_surface_projections
        (host_id, workspace_id, baseline_json) VALUES (?, ?, ?)`).run(
        hostId,
        workspaceId,
        JSON.stringify(baseline)
      )
    }
  }
  markSurfaceIndices(db, fingerprint)
}

/** Reducer changes become durable only when the owner co-writes this carrier and compatibility output. */
export function captureSurfaceProfileDomain(
  db: Database.Database,
  previous: SurfaceProfileDomain,
  changes?: SurfaceTransactionChanges
): SurfaceProfileDomain {
  requireTransaction(db)
  if (changes) {
    const domain = { ...previous, hosts: { ...previous.hosts } }
    const affected = new Set([
      ...changes.hosts.keys(),
      ...changes.surfaces.keys(),
      ...changes.allocations.keys(),
      ...changes.receipts.keys(),
      ...changes.baselines.keys()
    ])
    for (const hostId of affected) {
      const before = previous.hosts[hostId] ?? emptySurfaceHostDomain()
      const host = { ...before, ...changes.hosts.get(hostId) }
      host.surfaces = applyRows(before.surfaces, changes.surfaces.get(hostId), (surface) =>
        JSON.stringify([surface.workspaceId, surface.hostTabId])
      )
      host.allocations = applyRows(
        before.allocations,
        changes.allocations.get(hostId),
        (allocation) => allocation.allocationId
      )
      host.receipts = applyRows(before.receipts, changes.receipts.get(hostId), (receipt) =>
        JSON.stringify([receipt.callerId, receipt.commandId])
      )
      host.terminalBaselines = { ...before.terminalBaselines }
      for (const [workspaceId, baseline] of changes.baselines.get(hostId) ?? []) {
        if (baseline) {
          host.terminalBaselines[workspaceId] = baseline
        } else {
          delete host.terminalBaselines[workspaceId]
        }
      }
      domain.hosts[hostId] = host
    }
    return domain
  }
  const domain = structuredClone(previous)
  for (const row of db
    .prepare('SELECT host_id, initialized, revision FROM main.workspace_surface_domains')
    .all()) {
    const hostId = String(row.host_id)
    const host = domain.hosts[hostId] ?? emptySurfaceHostDomain()
    host.terminalInitialized = row.initialized === 1
    host.revision = Number(row.revision)
    host.surfaces = db
      .prepare('SELECT row_json FROM main.workspace_surfaces WHERE host_id = ? ORDER BY rowid')
      .all(hostId)
      .map((surface) => parseSurface(surface.row_json))
    host.receipts = db
      .prepare(`SELECT caller_id, command_id, fingerprint, expires_at, result_json
      FROM main.workspace_surface_commands WHERE host_id = ? ORDER BY rowid`)
      .all(hostId)
      .map((receipt) =>
        surfaceCommandReceiptSchema.parse({
          callerId: receipt.caller_id,
          commandId: receipt.command_id,
          fingerprint: receipt.fingerprint,
          expiresAt: Number(receipt.expires_at),
          outcome: surfaceCommandOutcomeSchema.parse(parseJson(receipt.result_json))
        })
      )
    host.allocations = db
      .prepare(
        'SELECT row_json FROM main.workspace_surface_allocations WHERE host_id = ? ORDER BY rowid'
      )
      .all(hostId)
      .map((allocation) => surfaceAllocationSchema.parse(parseJson(allocation.row_json)))
    host.terminalBaselines = Object.fromEntries(
      db
        .prepare(`SELECT workspace_id, baseline_json
      FROM main.workspace_surface_projections WHERE host_id = ? ORDER BY rowid`)
        .all(hostId)
        .map((projection) => [
          String(projection.workspace_id),
          surfaceProjectionSchema.parse(parseJson(projection.baseline_json))
        ])
    )
    domain.hosts[hostId] = host
  }
  return surfaceProfileDomainSchema.parse(domain)
}

function applyRows<T>(
  before: T[],
  changes: ReadonlyMap<string, T | null> | undefined,
  key: (row: T) => string
): T[] {
  if (!changes?.size) {
    return before
  }
  const rows: T[] = []
  const retained = new Set<string>()
  for (const old of before) {
    const id = key(old)
    const value = changes.has(id) ? changes.get(id) : old
    if (value) {
      rows.push(value)
    }
    retained.add(id)
  }
  for (const [id, value] of changes) {
    if (!retained.has(id) && value) {
      rows.push(value)
    }
  }
  return rows
}

export function markSurfaceIndices(db: Database.Database, fingerprint: string): void {
  requireTransaction(db)
  db.prepare(`INSERT INTO main.workspace_surface_index_meta(singleton, fingerprint) VALUES (1, ?)
    ON CONFLICT(singleton) DO UPDATE SET fingerprint = excluded.fingerprint`).run(fingerprint)
}

function requireTransaction(db: Database.Database): void {
  if (!db.isTransaction) {
    throw new Error('Surface storage requires the admitted profile transaction')
  }
}
