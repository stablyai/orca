import { afterEach, expect, it } from 'vitest'
import {
  domainLifecycleFixture,
  lifecycleIdentity,
  lifecycleOptions
} from './journal-domain-lifecycle.test-fixture'
import { readJournalSqlPoint } from './journal-sql-point-read'

const cleanup: (() => void)[] = []
afterEach(() => cleanup.splice(0).forEach((close) => close()))

it('refuses a single stored item over 64 MiB without loading it, and still reads ordinary ones', async () => {
  const f = domainLifecycleFixture(cleanup)
  for (const name of ['huge', 'small']) {
    await f.run({
      kind: 'item',
      identity: lifecycleIdentity(name),
      options: lifecycleOptions,
      body: { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: name }] }
    })
  }
  // Grown inside SQLite so the test never holds the oversized text in JS.
  f.db
    .prepare(
      `UPDATE journal_items SET payload_json=json_set(payload_json,'$.padding',hex(zeroblob(?)))
      WHERE item_id='orca:huge'`
    )
    .run(32 * 2 ** 20)
  const point = (kind: 'item' | 'item-detail', itemId: string) =>
    readJournalSqlPoint(f.db, { sessionId: 'chat', operation: { kind, itemId } })

  expect(() => point('item', 'orca:huge')).toThrow(/exceeds 67108864 bytes/)
  expect(() => point('item-detail', 'orca:huge')).toThrow(/exceeds 67108864 bytes/)
  expect(point('item', 'orca:small')).toMatchObject({ item: { itemId: 'orca:small' } })
})
