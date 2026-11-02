import { expect, vi } from 'vitest'
import Database from '../../sqlite/sync-database'
import { CONTEXT_TRANSFER_TABLE_SQL } from './context-transfer-repository'
import { ContextTransferFacts } from './context-transfer-facts'
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

/** Rows decoded, their JSON bytes, and statements that read the transfer table. */
export function instrumentContextTransferFacts(db: Database.Database) {
  // Each scale instruments afresh; a spy over a spy would wrap itself.
  for (const spy of instrumented.splice(0)) {
    spy.mockRestore()
  }
  const counts = { decodes: 0, decodedBytes: 0, transferQueries: 0 }
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
    counts.transferQueries += /^SELECT\b[\s\S]*\bagent_session_context_transfers\b/.test(sql)
      ? 1
      : 0
    return prepare(sql)
  })
  instrumented = [decode, select]
  const reset = () => Object.assign(counts, { decodes: 0, decodedBytes: 0, transferQueries: 0 })
  return { counts, reset }
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
