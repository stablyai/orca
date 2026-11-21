import { expect, vi } from 'vitest'
import type { OrchestrationDb } from '../../db/orchestration-db'

/** Count rows inside indexed SQL ranges, including owners with no eligible message. */
export function countDiscoveryRows(db: OrchestrationDb) {
  const owners: string[] = []
  const messages: string[] = []
  const plans: string[] = []
  const probes: string[] = []
  db.db.function('r4_owner_row', (id) => {
    owners.push(String(id))
    return 1
  })
  db.db.function('r4_message_row', (mailbox) => {
    messages.push(String(mailbox))
    return 1
  })
  const prepare = db.db.prepare.bind(db.db)
  const spy = vi.spyOn(db.db, 'prepare').mockImplementation((sql) => {
    const owner = sql.match(/FROM (runs|dispatch_contexts|remote_dispatch_attachments) INDEXED BY/)
    const exists = sql.includes('AS eligible')
    if (!owner && !exists) {
      return prepare(sql)
    }
    const instrumented = owner
      ? sql.replace(
          ' WHERE ',
          ` WHERE r4_owner_row(${owner[1] === 'remote_dispatch_attachments' ? 'dispatch_id' : 'id'}) AND `
        )
      : sql.replace('WHERE to_handle', 'WHERE r4_message_row(to_handle) AND to_handle')
    const statement = prepare(instrumented)
    return {
      ...statement,
      all(...bindings) {
        expect(
          prepare(`EXPLAIN QUERY PLAN ${instrumented}`)
            .all(...bindings)
            .map((row) => row.detail)
        ).toEqual(
          prepare(`EXPLAIN QUERY PLAN ${sql}`)
            .all(...bindings)
            .map((row) => row.detail)
        )
        plans.push(
          ...prepare(`EXPLAIN QUERY PLAN ${instrumented}`)
            .all(...bindings)
            .map((row) => String(row.detail))
        )
        return statement.all(...bindings)
      },
      get(...bindings) {
        expect(
          prepare(`EXPLAIN QUERY PLAN ${instrumented}`)
            .all(...bindings)
            .map((row) => row.detail)
        ).toEqual(
          prepare(`EXPLAIN QUERY PLAN ${sql}`)
            .all(...bindings)
            .map((row) => row.detail)
        )
        plans.push(
          ...prepare(`EXPLAIN QUERY PLAN ${instrumented}`)
            .all(...bindings)
            .map((row) => String(row.detail))
        )
        probes.push(String(bindings[0]))
        return statement.get(...bindings)
      }
    }
  })
  return {
    owners,
    messages,
    plans,
    probes,
    stop: () => spy.mockRestore(),
    clear() {
      owners.length = 0
      messages.length = 0
      probes.length = 0
      plans.length = 0
    }
  }
}
