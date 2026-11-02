import { expect, vi } from 'vitest'
import Database from '../../sqlite/sync-database'
import { CONTEXT_TRANSFER_TABLE_SQL } from './context-transfer-repository'
import { CONTEXT_TRANSFER_AUDIT_SQL, ContextTransferFacts } from './context-transfer-facts'
import { contextTransferRecordSchema, type ContextTransferRecord } from './context-transfer-record'

/** Seeds closed earlier histories, as clear and rewind retain them, around a chat's live facts. */
export function seedClosedContextHistories(
  db: Database.Database,
  sessionId: string,
  live: readonly ContextTransferRecord[],
  closed: number
): number {
  const handoff = live.find((row) => row.kind === 'handoff')
  const target = live.find((row) => row.kind === 'target')
  const delivery = live.find((row) => row.kind === 'delivery')
  if (handoff?.kind !== 'handoff' || target?.kind !== 'target' || delivery?.kind !== 'delivery') {
    throw new Error('Missing settled recovery facts')
  }
  if (!target.targetLink) {
    throw new Error('Missing published target')
  }
  const old: ContextTransferRecord[] = []
  for (let i = 0; i < closed; i++) {
    const handoffId = `old-H-${i}`
    const targetId = `old-T-${i}`
    old.push(
      { ...handoff, id: handoffId, handoffId },
      {
        ...target,
        id: targetId,
        handoffId,
        firstInputId: `old-P-${i}`,
        targetLink: {
          ...target.targetLink,
          linkId: `old-L-${i}`,
          handle: {
            ...target.targetLink.handle,
            nativeId: `00000000-0000-4000-9000-${String(i).padStart(12, '0')}`
          }
        }
      },
      { ...delivery, id: `old-D-${i}`, handoffId, targetId },
      {
        kind: 'closure',
        id: `old-C-${i}`,
        sessionId,
        handoffId,
        commandId: `clear-${i}`,
        at: 1,
        cause: 'context-clear'
      }
    )
  }
  db.prepare('DELETE FROM agent_session_context_transfers WHERE session_id = ?').run(sessionId)
  const insert = db.prepare(
    'INSERT INTO agent_session_context_transfers (id,session_id,handoff_id,kind,format,record_json) VALUES (?,?,?,?,1,?)'
  )
  for (const record of [...old, ...live]) {
    insert.run(record.id, sessionId, record.handoffId, record.kind, JSON.stringify(record))
  }
  return old.length + live.length
}

let instrumented: { mockRestore(): void }[] = []

function parsedJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

const JUMPS = new Set([
  'Eq',
  'Ne',
  'Lt',
  'Le',
  'Gt',
  'Ge',
  'IsNull',
  'NotNull',
  'If',
  'IfNot',
  'IsTrue',
  'IfNullRow',
  'IdxGT',
  'IdxGE',
  'IdxLT',
  'IdxLE',
  'DecrJumpZero',
  'IfPos',
  'Goto'
])

/** Whether a row loop of this statement can step past a row it visited, so its work exceeds its result. */
export function skipsVisitedRows(db: Database.Database, sql: string): boolean {
  const ops = db.prepare(`EXPLAIN ${sql}`).all()
  const at = (row: Record<string, unknown>) => Number(row.addr)
  return ops.some((next) => {
    if (next.opcode !== 'Next' && next.opcode !== 'Prev') {
      return false
    }
    const end = at(next)
    const start = Number(next.p2)
    const body = ops.filter((op) => at(op) >= start && at(op) < end)
    if (body.some((op) => op.opcode === 'Next' || op.opcode === 'Prev')) {
      return false
    }
    return body.some(
      (op) =>
        typeof op.opcode === 'string' &&
        JUMPS.has(op.opcode) &&
        Number(op.p2) >= start &&
        Number(op.p2) <= end
    )
  })
}

/** Keyed work after the open audit: rows decoded, their JSON bytes and statements reading transfers; the audit counts apart. */
export function instrumentContextTransferFacts(db: Database.Database) {
  // Each scale instruments afresh; a spy over a spy would wrap itself.
  for (const spy of instrumented.splice(0)) {
    spy.mockRestore()
  }
  const counts = {
    decodes: 0,
    decodedBytes: 0,
    transferQueries: 0,
    audits: 0,
    auditedRows: 0,
    auditedBytes: 0
  }
  const executed = new Set<string>()
  const parse = contextTransferRecordSchema.safeParse.bind(contextTransferRecordSchema)
  const decode = vi
    .spyOn(contextTransferRecordSchema, 'safeParse')
    .mockImplementation((value: unknown) => {
      counts.decodes += 1
      counts.decodedBytes += Buffer.byteLength(JSON.stringify(value), 'utf8')
      return parse(value)
    })
  const prepare = db.prepare.bind(db)
  const select = vi.spyOn(db, 'prepare').mockImplementation((sql: string) => {
    const statement = prepare(sql)
    if (sql === CONTEXT_TRANSFER_AUDIT_SQL) {
      counts.audits += 1
      return {
        ...statement,
        all: statement.all.bind(statement),
        get: statement.get.bind(statement),
        run: statement.run.bind(statement),
        setReadBigInts: statement.setReadBigInts.bind(statement),
        // Audited rows are decoded once each; keyed work is what remains.
        *iterate(...params) {
          for (const row of statement.iterate(...params)) {
            const bytes = typeof row.record_json === 'string' ? row.record_json : ''
            counts.auditedRows += 1
            counts.auditedBytes += Buffer.byteLength(bytes, 'utf8')
            const parsed = row.format === 1 ? parsedJson(bytes) : undefined
            if (parsed !== undefined) {
              counts.decodes -= 1
              counts.decodedBytes -= Buffer.byteLength(JSON.stringify(parsed), 'utf8')
            }
            yield row
          }
        }
      }
    }
    if (/^SELECT\b[\s\S]*\bagent_session_context_transfers\b/.test(sql)) {
      counts.transferQueries += 1
      executed.add(sql)
    }
    return statement
  })
  instrumented = [decode, select]
  const reset = () => {
    Object.assign(counts, {
      decodes: 0,
      decodedBytes: 0,
      transferQueries: 0,
      audits: 0,
      auditedRows: 0,
      auditedBytes: 0
    })
  }
  /** Transfer statements executed since instrumenting whose loops visit rows they don't return. */
  const unbounded = () => [...executed].filter((sql) => skipsVisitedRows(db, sql))
  return { counts, reset, unbounded }
}

/** Keyed facts over the given rows, stored in write order in a private in-memory table. */
export function contextTransferFactsOf(
  records: readonly ContextTransferRecord[],
  sessionId = records[0]?.sessionId ?? 'session'
): ContextTransferFacts {
  const db = new Database(':memory:')
  db.exec(CONTEXT_TRANSFER_TABLE_SQL)
  const insert = db.prepare(
    'INSERT INTO agent_session_context_transfers (id,session_id,handoff_id,kind,format,record_json) VALUES (?,?,?,?,1,?)'
  )
  for (const record of records) {
    insert.run(record.id, record.sessionId, record.handoffId, record.kind, JSON.stringify(record))
  }
  return new ContextTransferFacts(db, sessionId)
}

/** Same rows and queries at both scales; decoded bytes may differ only by longer identifiers and numbers. */
export function expectSameKeyedWork(
  small: { decodes: number; decodedBytes: number; transferQueries: number },
  large: { decodes: number; decodedBytes: number; transferQueries: number }
): void {
  expect({ decodes: large.decodes, transferQueries: large.transferQueries }).toEqual({
    decodes: small.decodes,
    transferQueries: small.transferQueries
  })
  expect(Math.abs(large.decodedBytes - small.decodedBytes)).toBeLessThanOrEqual(16 * small.decodes)
}
