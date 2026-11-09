import { afterEach, expect, it } from 'vitest'
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
