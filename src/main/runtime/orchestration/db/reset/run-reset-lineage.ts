import { createHash } from 'node:crypto'
import type { OrchestrationDb } from '../orchestration-db'
import {
  MAX_ROWS_PER_KIND,
  SCOPE_KINDS,
  readResetScope,
  type ResetScope
} from './run-reset-lineage-scope'

const MAX_BATCHES = 16
const MAX_SNAPSHOT_BYTES = 256 * 1024
const RETENTION = {
  maxRowsPerKind: MAX_ROWS_PER_KIND,
  maxBatches: MAX_BATCHES,
  maxBytes: MAX_SNAPSHOT_BYTES,
  endsWith: 'run_deletion'
} as const

type ResetBatch = {
  requestId: string | null
  requestDigest: string
  resetAt: string
  scope: ResetScope
}
type ResetLineageBody = {
  version: 1
  coverage: 'recorded_resets_only'
  retention: {
    maxRowsPerKind: number
    maxBatches: number
    maxBytes: number
    endsWith: 'run_deletion'
  }
  storeId: string
  runId: string
  resetCount: number
  droppedResetCount: number
  priorHistoryUnknown: boolean
  batches: ResetBatch[]
}
type ResetLineageSnapshot = ResetLineageBody & { digest: string }

export type RunResetLineage =
  | { status: 'unavailable'; reason: 'no_record' | 'invalid_record' }
  | { status: 'no_recorded_reset' }
  | (ResetLineageSnapshot & { status: 'complete' | 'incomplete' })

function makeBatch(
  db: OrchestrationDb,
  runId: string,
  requestId: string,
  resetAt: string
): ResetBatch {
  return {
    requestId: requestId.length <= 128 ? requestId : null,
    requestDigest: createHash('sha256').update(requestId).digest('hex'),
    resetAt,
    scope: readResetScope(db, runId)
  }
}

function digest(body: ResetLineageBody): string {
  return createHash('sha256').update(JSON.stringify(body)).digest('hex')
}

function snapshotBytes(body: ResetLineageBody): number {
  return Buffer.byteLength(JSON.stringify(body), 'utf8')
}

function fitSnapshot(body: ResetLineageBody): void {
  while (body.batches.length > MAX_BATCHES) {
    body.batches.shift()
    body.droppedResetCount += 1
  }
  while (snapshotBytes(body) > MAX_SNAPSHOT_BYTES) {
    if (body.batches.length > 1) {
      body.batches.shift()
      body.droppedResetCount += 1
      continue
    }
    const newest = body.batches[0]
    const kind = SCOPE_KINDS.toReversed().find((entry) => newest.scope[entry].rows.length > 0)
    if (!kind) {
      body.batches.shift()
      body.droppedResetCount += 1
      break
    }
    newest.scope[kind].rows.pop()
  }
}

function validSnapshot(value: unknown, runId: string): value is ResetLineageSnapshot {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Only property reads follow this object/null check; each property is checked below.
  const row = value as Record<string, unknown>
  if (
    row.version !== 1 ||
    row.coverage !== 'recorded_resets_only' ||
    typeof row.retention !== 'object' ||
    row.retention === null ||
    !('maxRowsPerKind' in row.retention) ||
    !('maxBatches' in row.retention) ||
    !('maxBytes' in row.retention) ||
    !('endsWith' in row.retention) ||
    row.retention.maxRowsPerKind !== MAX_ROWS_PER_KIND ||
    row.retention.maxBatches !== MAX_BATCHES ||
    row.retention.maxBytes !== MAX_SNAPSHOT_BYTES ||
    row.retention.endsWith !== 'run_deletion' ||
    row.runId !== runId ||
    typeof row.storeId !== 'string' ||
    typeof row.digest !== 'string' ||
    typeof row.resetCount !== 'number' ||
    typeof row.droppedResetCount !== 'number' ||
    typeof row.priorHistoryUnknown !== 'boolean' ||
    !Array.isArray(row.batches)
  ) {
    return false
  }
  const body: ResetLineageBody = {
    version: 1,
    coverage: 'recorded_resets_only',
    retention: RETENTION,
    storeId: row.storeId,
    runId,
    resetCount: row.resetCount,
    droppedResetCount: row.droppedResetCount,
    priorHistoryUnknown: row.priorHistoryUnknown,
    batches: row.batches
  }
  if (digest(body) !== row.digest) {
    return false
  }
  return row.batches.every((batch) => {
    if (
      typeof batch !== 'object' ||
      batch === null ||
      (batch.requestId !== null && typeof batch.requestId !== 'string') ||
      typeof batch.requestDigest !== 'string' ||
      typeof batch.resetAt !== 'string' ||
      typeof batch.scope !== 'object' ||
      batch.scope === null
    ) {
      return false
    }
    return SCOPE_KINDS.every((kind) => {
      const section: unknown = batch.scope[kind]
      return (
        typeof section === 'object' &&
        section !== null &&
        'total' in section &&
        'rows' in section &&
        Number.isSafeInteger(section.total) &&
        typeof section.total === 'number' &&
        section.total >= 0 &&
        Array.isArray(section.rows) &&
        section.rows.length <= section.total
      )
    })
  })
}

export function readRunResetLineage(db: OrchestrationDb, runId: string): RunResetLineage {
  const row = db.db.prepare('SELECT snapshot FROM run_reset_lineage WHERE run_id = ?').get(runId)
  if (!row) {
    return { status: 'unavailable', reason: 'no_record' }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The fixed SELECT returns a nullable text snapshot column.
  const raw = (row as { snapshot: string | null }).snapshot
  if (raw === null) {
    return { status: 'no_recorded_reset' }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { status: 'unavailable', reason: 'invalid_record' }
  }
  if (!validSnapshot(parsed, runId)) {
    return { status: 'unavailable', reason: 'invalid_record' }
  }
  const store = db.db
    .prepare(`SELECT caller_fingerprint FROM mutation_caller_identities
    WHERE transport = 'local_authenticated_transport'`)
    .get()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The fixed SELECT returns only the stored fingerprint or no row.
  const storeRow = store as { caller_fingerprint: string } | undefined
  if (parsed.storeId !== storeRow?.caller_fingerprint) {
    return { status: 'unavailable', reason: 'invalid_record' }
  }
  const complete =
    !parsed.priorHistoryUnknown &&
    parsed.droppedResetCount === 0 &&
    parsed.resetCount === parsed.batches.length &&
    parsed.batches.every((batch) =>
      SCOPE_KINDS.every((kind) => batch.scope[kind].rows.length === batch.scope[kind].total)
    )
  return { ...parsed, status: complete ? 'complete' : 'incomplete' }
}

export function captureRunResetLineage(
  db: OrchestrationDb,
  requestId: string
): {
  requestId: string
  affectedRuns: number
  incompleteRuns: number
} {
  const runs = db.db.prepare('SELECT id FROM runs ORDER BY id').all()
  const storeId = db.getOrCreateLocalMutationCallerFingerprint()
  const resetAt = new Date().toISOString()
  let incompleteRuns = 0
  for (const item of runs) {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The fixed SELECT projects the non-null Run primary key.
    const runId = (item as { id: string }).id
    const prior = readRunResetLineage(db, runId)
    const body: ResetLineageBody =
      prior.status === 'complete' || prior.status === 'incomplete'
        ? {
            version: 1,
            coverage: 'recorded_resets_only',
            retention: RETENTION,
            storeId,
            runId,
            resetCount: prior.resetCount + 1,
            droppedResetCount: prior.droppedResetCount,
            priorHistoryUnknown: prior.priorHistoryUnknown,
            batches: [...prior.batches, makeBatch(db, runId, requestId, resetAt)]
          }
        : {
            version: 1,
            coverage: 'recorded_resets_only',
            retention: RETENTION,
            storeId,
            runId,
            resetCount: 1,
            droppedResetCount: 0,
            priorHistoryUnknown: prior.status === 'unavailable',
            batches: [makeBatch(db, runId, requestId, resetAt)]
          }
    fitSnapshot(body)
    const snapshot: ResetLineageSnapshot = { ...body, digest: digest(body) }
    db.db
      .prepare(`INSERT INTO run_reset_lineage (run_id, snapshot) VALUES (?, ?)
      ON CONFLICT(run_id) DO UPDATE SET snapshot = excluded.snapshot`)
      .run(runId, JSON.stringify(snapshot))
    if (readRunResetLineage(db, runId).status !== 'complete') {
      incompleteRuns += 1
    }
  }
  return { requestId, affectedRuns: runs.length, incompleteRuns }
}
