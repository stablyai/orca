import { afterEach, expect, it } from 'vitest'
import type { AgentJournalRenderItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import { messageFixture } from './journal-sql-message.test-fixture'
import { journalSqlReads } from './journal-sql-reads'
import { readJournalSqlPoint } from './journal-sql-point-read'

const cleanup: (() => void)[] = []
afterEach(() => cleanup.splice(0).forEach((close) => close()))

function fixture() {
  const f = messageFixture()
  cleanup.push(() => f.db.close())
  return {
    ...f,
    reads: journalSqlReads({ point: async (request) => readJournalSqlPoint(f.db, request) }, 'chat')
  }
}

function item(
  itemId: string,
  sequence: number,
  body: AgentJournalRenderItem['body']
): AgentJournalRenderItem {
  return {
    itemId,
    sequence,
    revision: 1,
    observedAt: sequence,
    body,
    turnScope: { kind: 'thread' }
  }
}

it('reads visible provider namespaces and saved identities without decoding bodies or opening a journal handle', async () => {
  const { db, seedItem, reads } = fixture()
  seedItem(item('provider-turn', 1, { kind: 'turn', turnId: 'p:a%3Ab:first', state: 'completed' }))
  seedItem(
    item('other-namespace', 2, { kind: 'turn', turnId: 'p:a%3Abc:first', state: 'completed' })
  )
  seedItem(item('hidden', 3, { kind: 'turn', turnId: 'p:hidden:first', state: 'completed' }))
  db.exec(
    "UPDATE journal_items SET payload_json='invalid'; UPDATE journal_items SET hidden=1 WHERE item_id='hidden'"
  )
  expect(await reads.hasProviderTurn('a:b')).toBe(true)
  expect(await reads.hasProviderTurn('a')).toBe(false)
  expect(await reads.hasProviderTurn('hidden')).toBe(false)
  expect(
    await reads.savedItemIds(['missing', 'hidden', 'other-namespace', 'provider-turn'])
  ).toEqual(['other-namespace', 'provider-turn'])
})

it('loads both exact fork groups and the teardown anchors without touching unrelated history bodies', async () => {
  const { db, seedItem, reads } = fixture()
  seedItem(item('old', 1, { kind: 'status', text: 'old' }))
  seedItem(item('anchor', 2, { kind: 'status', text: 'boundary' }))
  seedItem({ ...item('same-group', 2, { kind: 'status', text: 'same' }), sequenceIndex: 1 })
  seedItem(item('prompt', 3, { kind: 'message', role: 'user', blocks: [] }))
  seedItem(
    item('settled', 4, { kind: 'turn', turnId: 'turn', state: 'completed', userItemId: 'prompt' })
  )
  seedItem(item('unrelated', 5, { kind: 'status', text: 'unrelated' }))
  db.exec("UPDATE journal_items SET payload_json='invalid' WHERE item_id='unrelated'")
  expect(
    (await reads.forkMarkerGroup({ kind: 'item', itemId: 'anchor' }, 1)).items.map(
      (row) => row.itemId
    )
  ).toEqual(['old', 'anchor', 'same-group'])
  expect(
    (await reads.generation({ teardownAnchors: true })).items.map((row) => row.itemId)
  ).toEqual(['prompt', 'settled'])
  db.exec("UPDATE journal_items SET hidden=1 WHERE item_id='anchor'")
  expect(
    (await reads.forkMarkerGroup({ kind: 'item', itemId: 'anchor' }, 1)).items.map(
      (row) => row.itemId
    )
  ).toEqual(['old'])
})
