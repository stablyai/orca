import type Database from '../../../../../sqlite/sync-database'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrchestrationDb } from '../../../../orchestration/db'
import { OrcaRuntimeService } from '../../../../orca-runtime'
import { ORCHESTRATION_WORKER_LIST_METHOD } from './worker-list-method'

let db: OrchestrationDb | undefined
afterEach(() => {
  db?.close()
  vi.restoreAllMocks()
})
function inventory(size: number) {
  db = new OrchestrationDb(':memory:')
  const database = db
  const runtime = new OrcaRuntimeService()
  runtime.setOrchestrationDb(database)
  const run = database.createRun({
    objective: 'Ordered pages',
    coordinatorHandle: 'term-test',
    coordinatorPaneKey: 'tab-test:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  })
  const insert = () => {
    const task = database.createTask({ spec: 'worker', runId: run.id })
    return database.createDispatchContext({
      taskId: task.id,
      assigneeHandle: `term-${task.id}`,
      creator: { kind: 'system' },
      maxDepth: 10
    }).id
  }
  const ids = Array.from({ length: size }, insert)
  const list = (params: Record<string, unknown> = {}) =>
    ORCHESTRATION_WORKER_LIST_METHOD.handler(
      ORCHESTRATION_WORKER_LIST_METHOD.params.parse({ run: run.id, paginate: true, ...params }),
      { runtime }
    )
  return { ids, insert, list, run, database }
}
describe('newest-first worker-list', () => {
  it('starts with the newest 20 of 106 and walks older rows without including later inserts', async () => {
    const { ids, insert, list } = inventory(106)
    const first = await list({ order: 'desc', limit: 20 })
    expect(first.workers.map((row) => row.dispatchId)).toEqual(ids.slice(-20).toReversed())
    expect(first.page).toMatchObject({ order: 'desc', total: 106, hasMore: true })
    const late = insert()
    const received = first.workers.map((row) => row.dispatchId)
    let cursor = first.page.nextCursor
    while (cursor) {
      const next = await list({ cursor, limit: 20 })
      received.push(...next.workers.map((row) => row.dispatchId))
      cursor = next.page.nextCursor
    }
    expect(received).toEqual(ids.toReversed())
    expect(received).not.toContain(late)
    expect((await list({ order: 'desc', limit: 1 })).workers[0].dispatchId).toBe(late)
  })
})

it.each([0, 1, 20, 21, 100, 101])(
  'handles %i rows with unchanged default ordering',
  async (size) => {
    const { ids, list } = inventory(size)
    const original = await list({ limit: 20 })
    expect(original.workers.map((row) => row.dispatchId)).toEqual(ids.slice(0, 20))
    expect(original.page).not.toHaveProperty('order')
    const desc = await list({ order: 'desc', limit: 20 })
    expect(desc.workers.map((row) => row.dispatchId)).toEqual(ids.toReversed().slice(0, 20))
    expect(desc.page).toMatchObject({ order: 'desc', total: size, hasMore: size > 20 })
  }
)

it('rejects changed order, Run or filter and refuses ascending cursors in descending mode', async () => {
  const { list } = inventory(3)
  const first = await list({ order: 'desc', limit: 1 })
  for (const changed of [{ order: 'asc' }, { run: 'other-run' }, { terminalState: 'active' }]) {
    await expect(list({ cursor: first.page.nextCursor, ...changed })).rejects.toMatchObject({
      code: 'invalid_argument'
    })
  }
  const asc = await list({ limit: 1 })
  await expect(list({ cursor: asc.page.nextCursor, order: 'desc' })).rejects.toMatchObject({
    code: 'invalid_argument'
  })
  expect(
    (await list({ cursor: asc.page.nextCursor, order: 'asc', limit: 1 })).workers
  ).toHaveLength(1)
})

it('keeps a descending filtered snapshot even after membership changes', async () => {
  const { ids, list, database } = inventory(3)
  const first = await list({ order: 'desc', terminalState: 'retained', limit: 1 })
  expect(first.workers[0].dispatchId).toBe(ids[2])
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The real database owns this SQLite connection; the test changes only its in-memory fixture.
  const sql = (database as unknown as { db: Database }).db
  sql.prepare('UPDATE dispatch_contexts SET assignee_handle = NULL WHERE id = ?').run(ids[1])
  const second = await list({ cursor: first.page.nextCursor, terminalState: 'retained', limit: 1 })
  expect(second.workers[0].dispatchId).toBe(ids[1])
  expect(second.page).toMatchObject({ total: 3, order: 'desc', hasMore: true })
  expect(second.counts).toEqual({ retained: 3 })
  expect(
    (await list({ cursor: second.page.nextCursor, terminalState: 'retained', limit: 1 })).workers[0]
      .dispatchId
  ).toBe(ids[0])
})

it('expires a filtered cursor when its retained snapshot is evicted', async () => {
  const { list } = inventory(3)
  const first = await list({ order: 'desc', terminalState: 'retained', limit: 1 })
  for (let index = 0; index < 33; index++) {
    await list({ order: 'desc', terminalState: 'retained', limit: 1 })
  }
  await expect(
    list({ cursor: first.page.nextCursor, terminalState: 'retained', limit: 1 })
  ).rejects.toMatchObject({ code: 'worker_list_cursor_expired' })
})

it('expires a descending cursor whose anchor was removed', async () => {
  const { ids, list, database } = inventory(3)
  const first = await list({ order: 'desc', limit: 1 })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This connection belongs to this test's in-memory fixture.
  const sql = (database as unknown as { db: Database }).db
  sql.prepare('DELETE FROM dispatch_contexts WHERE id = ?').run(ids[2])
  await expect(list({ cursor: first.page.nextCursor, limit: 1 })).rejects.toMatchObject({
    code: 'worker_list_cursor_expired'
  })
})

it('selects only one page of detail rows even when timestamps are identical', async () => {
  const { ids, database, list } = inventory(106)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This is the SQLite connection owned by the isolated in-memory fixture.
  const sql = (database as unknown as { db: Database }).db
  sql.prepare("UPDATE dispatch_contexts SET created_at = '2026-09-18 00:00:00'").run()
  const reads = vi.spyOn(database, 'listWorkerTerminalResources')
  const result = await list({ order: 'desc', limit: 20 })
  expect(result.workers.map((row) => row.dispatchId)).toEqual(ids.slice(-20).toReversed())
  expect(reads).toHaveBeenCalledTimes(1)
  expect(reads.mock.calls[0][0]).toMatchObject({ order: 'desc', limit: 21 })
})
