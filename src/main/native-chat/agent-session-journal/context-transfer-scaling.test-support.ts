import { vi } from 'vitest'
import type Database from '../../sqlite/sync-database'
import { contextTransferRecordSchema, type ContextTransferRecord } from './context-transfer-record'
import * as transferState from './context-transfer-state'

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

/** Decodes, fact loads, and record-kind reads made outside load passes (a load reads each record once by design). */
let instrumented: { mockRestore(): void }[] = []

export function instrumentContextTransferFacts(db: Database.Database) {
  // Each scale instruments afresh; a spy over a spy would wrap itself.
  for (const spy of instrumented.splice(0)) {
    spy.mockRestore()
  }
  const counts = { decodes: 0, loads: 0, kindReads: 0, transferSelects: 0 }
  let counting = true
  const parse = contextTransferRecordSchema.safeParse.bind(contextTransferRecordSchema)
  const decode = vi
    .spyOn(contextTransferRecordSchema, 'safeParse')
    .mockImplementation((value: unknown) => {
      counting = false
      counts.decodes += 1
      const result = parse(value)
      if (result.success) {
        const record = result.data
        const kind = record.kind
        Object.defineProperty(record, 'kind', {
          enumerable: true,
          get: () => {
            counts.kindReads += counting ? 1 : 0
            return kind
          }
        })
      }
      return result
    })
  const track = transferState.trackContextTransferLookup
  const load = vi
    .spyOn(transferState, 'trackContextTransferLookup')
    .mockImplementation((records) => {
      counts.loads += 1
      track(records)
      counting = true
    })
  const prepare = db.prepare.bind(db)
  const select = vi.spyOn(db, 'prepare').mockImplementation((sql: string) => {
    counts.transferSelects += sql.startsWith('SELECT id, session_id, handoff_id') ? 1 : 0
    return prepare(sql)
  })
  instrumented = [decode, load, select]
  const reset = () =>
    Object.assign(counts, { decodes: 0, loads: 0, kindReads: 0, transferSelects: 0 })
  return { counts, reset }
}
