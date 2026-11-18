import { afterEach, expect, it } from 'vitest'
import {
  domainLifecycleFixture,
  lifecycleIdentity,
  lifecycleOptions
} from './journal-domain-lifecycle.test-fixture'
import { readJournalSqlPoint } from './journal-sql-point-read'
import { limitJournalReaderReply } from './journal-sql-reader-reply-limit'

const cleanup: (() => void)[] = []
afterEach(() => cleanup.splice(0).forEach((close) => close()))

it('refuses full reads of an item over 64 MiB, shortens its display and visit forms, and reads ordinary items', async () => {
  const f = domainLifecycleFixture(cleanup)
  const output = { head: 'start', byteLength: 5, digest: '0'.repeat(64), truncated: false }
  for (const name of ['huge-message', 'huge-tool', 'small-tool']) {
    await f.run({
      kind: 'item',
      identity: lifecycleIdentity(name),
      options: lifecycleOptions,
      body:
        name === 'huge-message'
          ? { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: name }] }
          : { kind: 'tool-call', name: 'read', input: {}, output, state: 'completed' }
    })
  }
  // Grown inside SQLite so the test never holds the oversized text in JS. Newlines are stored
  // escaped, so the tool row takes 68 MiB stored but its head only 34 MiB once extracted.
  const grow = f.db.prepare(
    `UPDATE journal_items SET payload_json=json_set(payload_json,?,replace(hex(zeroblob(?)),'0',?))
    WHERE item_id=?`
  )
  grow.run('$.padding', 32 * 2 ** 20, 'x', 'orca:huge-message')
  grow.run('$.body.output.head', 17 * 2 ** 20, '\n', 'orca:huge-tool')
  const point = (kind: 'item' | 'item-detail', itemId: string) =>
    readJournalSqlPoint(f.db, { sessionId: 'chat', operation: { kind, itemId } })

  expect(() => point('item', 'orca:huge-message')).toThrow(/exceeds 67108864 bytes/)
  expect(() => point('item-detail', 'orca:huge-message')).toThrow(/exceeds 67108864 bytes/)
  expect(() => point('item', 'orca:huge-tool')).toThrow(/exceeds 67108864 bytes/)
  const detail = point('item-detail', 'orca:huge-tool')
  if (detail.kind !== 'item-detail' || detail.item?.body.kind !== 'tool-call') {
    throw new Error('detail unavailable')
  }
  expect(detail.item.body.output).toMatchObject({ byteLength: 5, truncated: true })
  expect(detail.item.body.output!.head).toBe('\n'.repeat(16 * 1024))

  const visit = readJournalSqlPoint(f.db, {
    sessionId: 'chat',
    operation: { kind: 'items-by-kind', kinds: ['tool-call'], afterOrdinal: -1, limit: 10 }
  })
  if (visit.kind !== 'items-by-kind') {
    throw new Error('visit unavailable')
  }
  expect(visit.items.map((item) => item.itemId)).toEqual(['orca:huge-tool', 'orca:small-tool'])
  expect(point('item', 'orca:small-tool')).toMatchObject({ item: { itemId: 'orca:small-tool' } })
})

it('refuses a reply carrying one item over the reply limit', () => {
  const reply = {
    type: 'point' as const,
    id: 7,
    result: { kind: 'item' as const, item: { itemId: 'orca:big', text: 'x'.repeat(4096) } }
  }
  expect(limitJournalReaderReply(reply, 1024)).toMatchObject({
    type: 'failed',
    id: 7,
    error: { message: 'journal read reply (point) exceeds 1024 bytes' }
  })
})
