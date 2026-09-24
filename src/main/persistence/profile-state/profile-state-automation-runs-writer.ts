import type Database from '../../sqlite/sync-database'
import type { PreparedProfileStateMutation } from './profile-state-domain-write-validation'
import {
  AUTOMATION_RUNS_ARRAY,
  AUTOMATION_RUNS_DOMAIN,
  PROFILE_STATE_AUTOMATION_RUNS_META_TABLE,
  PROFILE_STATE_AUTOMATION_RUNS_TABLE,
  type AutomationRunIdentity,
  type ParsedAutomationRunsReplacement
} from './profile-state-automation-runs-model'
import {
  parseAutomationRunValues,
  parseAutomationRunsReplacement,
  parseAutomationRunsValue
} from './profile-state-automation-runs-payload'
import { parseAutomationRunIdentity } from './profile-state-automation-runs-validation'
import {
  readCurrentAutomationRunsState,
  compactAutomationRunsDocument
} from './profile-state-automation-runs-storage'

export type AutomationRunsWritePreparation = {
  changed: boolean
  incoming: ParsedAutomationRunsReplacement
  domainVersion: number
  now?: () => number
}

export function rebuildProfileStateAutomationRunsProjection(
  db: Database.Database,
  payload: string,
  domainVersion: number,
  updatedAt: number,
  revision: number
): boolean {
  const incoming = parseAutomationRunsReplacement(payload)
  if (incoming === undefined) {
    return false
  }
  const now = resolveAutomationRunsTimestamp(() => updatedAt)
  applyIncomingAutomationRuns(db, incoming, domainVersion, now, revision)
  return true
}

export function prepareProfileStateAutomationRunsReplacement(
  db: Database.Database,
  replacement: PreparedProfileStateMutation,
  actualRevision: number
): AutomationRunsWritePreparation | undefined {
  const current = readCurrentAutomationRunsState(db, actualRevision)
  const incoming = parseAutomationRunsValue(replacement.automationRunsValue)
  if (incoming === undefined) {
    return undefined
  }
  return {
    changed: current.presence !== incoming.presence || current.contentHash !== incoming.contentHash,
    incoming,
    domainVersion: replacement.domainVersion,
    now: replacement.now
  }
}

export function prepareProfileStateAutomationRunsDelta(
  db: Database.Database,
  after: readonly unknown[],
  domainVersion: number,
  now: () => number,
  actualRevision: number
): AutomationRunsWritePreparation | undefined {
  const incoming = parseAutomationRunValues(after)
  if (incoming === undefined) {
    return undefined
  }
  const current = readCurrentAutomationRunsState(db, actualRevision)
  return {
    changed: current.presence !== incoming.presence || current.contentHash !== incoming.contentHash,
    incoming,
    domainVersion,
    now
  }
}

export function applyProfileStateAutomationRuns(
  db: Database.Database,
  preparation: AutomationRunsWritePreparation,
  nextRevision: number
): void {
  const now = resolveAutomationRunsTimestamp(preparation.now ?? Date.now)
  applyIncomingAutomationRuns(
    db,
    preparation.incoming,
    preparation.domainVersion,
    now,
    nextRevision
  )
}

function applyIncomingAutomationRuns(
  db: Database.Database,
  incoming: ParsedAutomationRunsReplacement,
  domainVersion: number,
  now: number,
  nextRevision: number
): void {
  const existingRows = new Map<string, AutomationRunIdentity>()
  for (const row of db
    .prepare(`SELECT run_id, ordinal, content_hash FROM ${PROFILE_STATE_AUTOMATION_RUNS_TABLE}`)
    .all()) {
    const parsed = parseAutomationRunIdentity(row)
    existingRows.set(parsed.id, parsed)
  }

  const incomingIds = new Set<string>()
  const upsert = db.prepare(
    `INSERT INTO ${PROFILE_STATE_AUTOMATION_RUNS_TABLE}
     (run_id, ordinal, payload, content_hash, revision, updated_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(run_id) DO UPDATE SET ordinal = excluded.ordinal,
     payload = excluded.payload, content_hash = excluded.content_hash,
     revision = excluded.revision, updated_at = excluded.updated_at`
  )
  if (incoming.presence === AUTOMATION_RUNS_ARRAY) {
    for (const run of incoming.runs) {
      incomingIds.add(run.id)
      const existing = existingRows.get(run.id)
      if (existing?.ordinal === run.ordinal && existing.contentHash === run.contentHash) {
        continue
      }
      upsert.run(run.id, run.ordinal, run.payload, run.contentHash, nextRevision, now)
    }
  }
  const remove = db.prepare(`DELETE FROM ${PROFILE_STATE_AUTOMATION_RUNS_TABLE} WHERE run_id = ?`)
  for (const id of existingRows.keys()) {
    if (!incomingIds.has(id)) {
      remove.run(id)
    }
  }

  db.prepare(
    `INSERT INTO ${PROFILE_STATE_AUTOMATION_RUNS_META_TABLE}
     (domain, presence, domain_version, revision, updated_at, content_hash) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(domain) DO UPDATE SET presence = excluded.presence,
     domain_version = excluded.domain_version, revision = excluded.revision,
     updated_at = excluded.updated_at, content_hash = excluded.content_hash`
  ).run(
    AUTOMATION_RUNS_DOMAIN,
    incoming.presence,
    domainVersion,
    nextRevision,
    now,
    incoming.contentHash
  )
  compactAutomationRunsDocument(db)
}

function resolveAutomationRunsTimestamp(nowFactory: () => number): number {
  const now = nowFactory()
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new Error('Profile state domain update timestamp is invalid: automationRuns')
  }
  return now
}
