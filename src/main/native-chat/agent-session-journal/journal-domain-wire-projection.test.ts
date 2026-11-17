import { afterEach, expect, it, vi } from 'vitest'
import {
  domainLifecycleFixture,
  lifecycleIdentity,
  lifecycleOptions
} from './journal-domain-lifecycle.test-fixture'
import { readJournalSqlPoint } from './journal-sql-point-read'
import { readJournalDomainHistoryPage } from './journal-domain-history-page'

const cleanup: (() => void)[] = []
afterEach(() => cleanup.splice(0).forEach((close) => close()))

it('serves bounded history and detail without decoding originals, then replaces both with the next revision', async () => {
  const f = domainLifecycleFixture(cleanup)
  const head = 'é'.repeat(3 * 1024 * 1024)
  const output = { head, byteLength: 6 * 1024 * 1024, digest: '0'.repeat(64), truncated: false }
  await f.run({
    kind: 'item',
    identity: lifecycleIdentity('tool'),
    options: lifecycleOptions,
    body: { kind: 'tool-call', name: 'read', input: {}, output, state: 'completed' }
  })
  const point = (kind: 'item' | 'item-detail') =>
    readJournalSqlPoint(f.db, {
      sessionId: 'chat',
      operation: { kind, itemId: 'orca:tool' }
    })
  expect(point('item')).toMatchObject({ item: { body: { output } } })
  const original = f.db
    .prepare("SELECT payload_json FROM journal_items WHERE item_id='orca:tool'")
    .get()!.payload_json
  f.db
    .prepare("UPDATE journal_items SET payload_json=? WHERE item_id='orca:tool'")
    .run('original must not be decoded')
  const tail = readJournalDomainHistoryPage(f.db, { sessionId: 'chat', direction: 'tail' })
  const forward = readJournalDomainHistoryPage(f.db, {
    sessionId: 'chat',
    direction: 'after',
    cursor: { epoch: 'epoch', sequence: 0 }
  })
  expect(tail.page.items[0]).toMatchObject({
    revision: 1,
    shortened: true,
    body: { output: { truncated: true } }
  })
  expect(forward.page.items).toEqual(tail.page.items)
  const item = point('item-detail')
  if (item.kind !== 'item-detail' || item.item?.body.kind !== 'tool-call') {
    throw new Error('detail unavailable')
  }
  expect(item.item.shortened).toBe(true)
  expect(item.item.body.output!.head.length).toBeGreaterThan(16 * 1024)
  expect(Buffer.byteLength(JSON.stringify(item.item))).toBeLessThan(4 * 1024 * 1024)
  f.db.prepare("UPDATE journal_items SET payload_json=? WHERE item_id='orca:tool'").run(original)
  await f.run({
    kind: 'item',
    identity: lifecycleIdentity('tool'),
    options: lifecycleOptions,
    body: {
      kind: 'tool-call',
      name: 'read',
      input: {},
      output: { ...output, head: 'new result', byteLength: 10 },
      state: 'completed'
    }
  })
  expect(point('item-detail')).toMatchObject({
    item: { revision: 2, body: { output: { head: 'new result' } } }
  })
  expect(
    readJournalDomainHistoryPage(f.db, { sessionId: 'chat', direction: 'tail' }).page.items[0]
  ).toMatchObject({ revision: 2, body: { output: { head: 'new result' } } })
})

it.each([null, 0])(
  'recomputes a missing or stale client form and its admission size (%s)',
  async (version) => {
    const f = domainLifecycleFixture(cleanup)
    for (const value of ['first', 'second']) {
      await f.run({
        kind: 'item',
        identity: lifecycleIdentity(value),
        options: lifecycleOptions,
        body: { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: value }] }
      })
    }
    const plans = vi.spyOn(f.db, 'prepare')
    f.db
      .prepare(`UPDATE journal_items SET wire_version=?,wire_bytes=99999999,
    wire_json=json_set(payload_json,'$.body.blocks[0].text','stale cache'),
    detail_json=json_set(payload_json,'$.body.blocks[0].text','stale cache')`)
      .run(version)
    const tail = readJournalDomainHistoryPage(f.db, {
      sessionId: 'chat',
      direction: 'tail',
      reader: { form: 'client', budgetBytes: 4096 }
    })
    expect(tail.page.items).toMatchObject([
      { itemId: 'orca:first', body: { blocks: [{ text: 'first' }] } },
      { itemId: 'orca:second', body: { blocks: [{ text: 'second' }] } }
    ])
    expect(
      readJournalDomainHistoryPage(f.db, {
        sessionId: 'chat',
        direction: 'after',
        cursor: { epoch: 'epoch', sequence: 0 },
        reader: { form: 'client', budgetBytes: 4096 }
      }).page.items
    ).toEqual(tail.page.items)
    expect(
      readJournalSqlPoint(f.db, {
        sessionId: 'chat',
        operation: { kind: 'item-detail', itemId: 'orca:first' }
      })
    ).toMatchObject({ item: { body: { blocks: [{ text: 'first' }] } } })
    const setReads = [
      ...new Set(
        plans.mock.calls
          .map(([sql]) => sql)
          .filter(
            (sql) =>
              sql.includes('CROSS JOIN journal_items item') &&
              sql.includes('item.item_id=wanted.value')
          )
      )
    ]
    plans.mockRestore()
    expect(setReads.length).toBeGreaterThan(0)
    for (const sql of setReads) {
      const plan = f.db
        .prepare(`EXPLAIN QUERY PLAN ${sql}`)
        .all()
        .map((row) => String(row.detail))
        .join('\n')
      expect(plan).toMatch(/SEARCH item USING INDEX sqlite_autoindex_journal_items_/)
      if (!sql.includes('ORDER BY')) {
        expect(plan).not.toContain('TEMP B-TREE')
      }
    }
    f.db
      .prepare(
        `UPDATE journal_items SET wire_version=1,wire_bytes=NULL,wire_json=NULL,detail_json=NULL WHERE item_id='orca:second'`
      )
      .run()
    expect(
      readJournalDomainHistoryPage(f.db, {
        sessionId: 'chat',
        direction: 'tail',
        reader: { form: 'client', budgetBytes: 4096 }
      }).page.items
    ).toEqual(tail.page.items)
  }
)
