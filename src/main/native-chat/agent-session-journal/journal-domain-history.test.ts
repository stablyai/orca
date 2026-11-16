import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import Database from '../../sqlite/sync-database'
import type { AgentSessionHistoryResult } from '../../../shared/agent-session/agent-session-wire'
import type { AgentJournalRenderItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import {
  measureHistoryItem,
  HISTORY_PAGE_CONTENT_BUDGET_BYTES,
  BOUNDED_FRAME_CONTENT_BUDGET_BYTES
} from '../agent-session-wire/publication/history/agent-session-history-page-bounds'
import { message, messageFixture, target } from './journal-sql-message.test-fixture'
import {
  readJournalDomainHistoryPage,
  type JournalDomainHistoryRequest
} from './journal-domain-history-page'
import { insertJournalDomainQueueRow } from './journal-domain-queue-rows'
import { captureJournalMetadataPlans } from './journal-domain-metadata-plan.test-fixture'

const cleanup: (() => void)[] = []
afterEach(() => {
  for (const step of cleanup.splice(0)) {
    step()
  }
})

function history(db = new Database(':memory:')) {
  const value = messageFixture(db)
  cleanup.push(() => db.close())
  return {
    ...value,
    head: (sequence: number, retained = 0) =>
      db
        .prepare('UPDATE journal_chat_state SET last_sequence=?, retained_sequence=?')
        .run(sequence, retained),
    event: (sequence: number, itemIds: string[]) =>
      db.prepare('INSERT INTO journal_events VALUES(?,?,?,0,?)').run(
        target.sessionId,
        target.epoch,
        sequence,
        JSON.stringify({
          items: itemIds.map((itemId) => ({ itemId, revision: 1, sequence, sequenceIndex: 0 })),
          submissions: [],
          cards: []
        })
      ),
    read: (
      request: Omit<JournalDomainHistoryRequest, 'sessionId'>,
      reader?: Parameters<typeof readJournalDomainHistoryPage>[2]
    ) => readJournalDomainHistoryPage(db, { sessionId: target.sessionId, ...request }, reader)
  }
}

function text(
  sequence: number,
  value: string,
  extra: Partial<AgentJournalRenderItem> = {}
): AgentJournalRenderItem {
  return {
    itemId: `orca:${sequence}:${extra.sequenceIndex ?? 0}`,
    revision: 1,
    sequence,
    observedAt: sequence,
    body: { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: value }] },
    turnScope: { kind: 'thread' },
    ...extra
  }
}

const sequences = (result: AgentSessionHistoryResult) =>
  result.page.items.map((item) => item.sequence)

it('pages a chat of almost only subagent rows in bounded, gap-free pages', () => {
  const { db, seedItem, head, read } = history()
  const assertPlans = captureJournalMetadataPlans(db, 'SELECT item_id')
  seedItem({
    ...text(1, ''),
    body: {
      kind: 'message',
      role: 'assistant',
      blocks: [{ type: 'subagent', id: 'child', label: 'Child', state: 'working', groupId: 'g' }]
    }
  })
  for (let sequence = 2; sequence <= 301; sequence++) {
    seedItem(text(sequence, 'child work', { agentId: 'child' }))
  }
  head(301)
  let result = read({ direction: 'tail', limit: 40 })
  expect(result.page.subagentRoster).toMatchObject([
    { itemId: 'orca:1:0', sequence: 1, entry: { id: 'child', label: 'Child' } }
  ])
  const sizes: number[] = []
  const seen: number[] = []
  for (;;) {
    expect(result.ok).toBe(true)
    sizes.push(result.page.items.length)
    seen.unshift(...sequences(result))
    if (!result.page.hasOlder) {
      break
    }
    result = read({ direction: 'before', cursor: result.page.window.nextCursor, limit: 40 })
  }
  expect(sizes).toEqual([80, 80, 80, 61])
  expect(seen).toEqual(Array.from({ length: 301 }, (_, index) => index + 1))
  assertPlans()
})

it('keeps revised naming items at their visible history position and removes obsolete names', async () => {
  const { db, seedItem, head, commit, read } = history()
  const naming = (label: string): AgentJournalRenderItem['body'] => ({
    kind: 'message',
    role: 'assistant',
    blocks: [{ type: 'subagent', id: 'child', label, state: 'working', groupId: 'group' }]
  })
  seedItem({ ...text(1, ''), itemId: 'orca:first', body: naming('First') })
  seedItem({ ...text(2, ''), itemId: 'orca:second', body: naming('Second') })
  for (const sequence of [20, 21, 22]) {
    seedItem(text(sequence, 'child work', { agentId: 'child' }))
  }
  head(22)
  const revision = message('', 'first', 'item')
  revision.body.blocks = [
    { type: 'subagent', id: 'child', label: 'Revised', state: 'working', groupId: 'group' }
  ]
  await commit(revision)
  expect(read({ direction: 'tail', limit: 1 }).page.subagentRoster).toMatchObject([
    { itemId: 'orca:first', sequence: 1, entry: { id: 'child', label: 'Revised' } }
  ])

  // A restored hidden row stays hidden when its body is revised.
  db.exec(`UPDATE journal_items SET hidden=1 WHERE item_id='orca:first';
    UPDATE journal_item_subagent_names SET hidden=1 WHERE item_id='orca:first'`)
  await commit(revision)
  expect(read({ direction: 'tail', limit: 1 }).page.subagentRoster).toMatchObject([
    { itemId: 'orca:second', sequence: 2, entry: { id: 'child', label: 'Second' } }
  ])
  await commit(message('no longer names a child', 'second', 'item'))
  expect(read({ direction: 'tail', limit: 1 }).page.subagentRoster).toBeUndefined()
})

it('never splits a same-sequence group, marking it oversized backward and paging it whole forward', () => {
  const { db, seedItem, head, event, read } = history()
  const group = Array.from({ length: 200 }, (_, index) =>
    text(50, 'x'.repeat(1000), { sequenceIndex: index })
  )
  seedItem(text(49, 'before'))
  event(49, ['orca:49:0'])
  for (const item of group) {
    seedItem(item)
  }
  event(
    50,
    group.map((item) => item.itemId)
  )
  for (let sequence = 51; sequence <= 60; sequence++) {
    seedItem(text(sequence, 'after'))
    event(sequence, [`orca:${sequence}:0`])
  }
  head(60, 48)
  const originals = db
    .prepare('SELECT item_id,payload_json FROM journal_items WHERE sequence=50')
    .all()
  db.prepare('UPDATE journal_items SET payload_json=? WHERE sequence=50').run('x'.repeat(1000))
  const small = { form: measureHistoryItem, budgetBytes: 50_000 }
  const tail = read({ direction: 'tail', limit: 40 }, small)
  expect(sequences(tail)).toEqual([51, 52, 53, 54, 55, 56, 57, 58, 59, 60])
  const wide = read({ direction: 'before', cursor: tail.page.window.nextCursor, limit: 40 }, small)
  expect(wide.page.items.map((item) => item.itemId)).toEqual(group.map((item) => item.itemId))
  expect(new Set(wide.page.items.map((item) => item.body.kind))).toEqual(new Set(['status']))
  expect(wide.page).toMatchObject({ hasOlder: true, window: { nextCursor: { sequence: 50 } } })
  const rest = read({ direction: 'before', cursor: wide.page.window.nextCursor, limit: 40 }, small)
  expect(sequences(rest)).toEqual([49])
  expect(rest.page.hasOlder).toBe(false)

  for (const row of originals) {
    db.prepare('UPDATE journal_items SET payload_json=? WHERE item_id=?').run(
      row.payload_json,
      row.item_id
    )
  }
  const forward: string[] = []
  let cursor = { epoch: 'epoch', sequence: 48 }
  for (const expected of [true, true, false]) {
    const page = read({ direction: 'after', cursor, limit: 4 })
    expect(page).toMatchObject({ ok: true, page: { hasNewer: expected } })
    forward.push(...page.page.items.map((item) => item.itemId))
    cursor = page.page.window.nextCursor
  }
  expect(cursor.sequence).toBe(60)
  expect(forward).toEqual([
    'orca:49:0',
    ...group.map((item) => item.itemId),
    ...Array.from({ length: 10 }, (_, index) => `orca:${51 + index}:0`)
  ])
})

it('excludes a retained body and submission by stored size before reading either, in both directions', () => {
  const { db, seedItem, head, event, read } = history()
  for (let sequence = 1; sequence <= 4; sequence++) {
    seedItem(text(sequence, 'row'))
    event(sequence, [`orca:${sequence}:0`])
  }
  head(4)
  // An excluded body must not be decoded.
  db.prepare("UPDATE journal_items SET payload_json=? WHERE item_id='orca:2:0'").run(
    `{"pad":"${'x'.repeat(10_000)}",}`
  )
  db.exec(`INSERT INTO journal_submission_attempts(session_id,epoch,message_id,attempt_sequence,
    attempt_index,current,item_id,ordinal,submitted_at,fingerprint,dispatch_state,payload_json)
    VALUES('chat','epoch','send',2,0,1,'orca:2:0',2,2,'f','accepted','not json')`)
  const small = { form: measureHistoryItem, budgetBytes: 4096 }
  const tail = read({ direction: 'tail' }, small)
  expect(sequences(tail)).toEqual([3, 4])
  expect(tail.page).toMatchObject({ hasOlder: true, window: { nextCursor: { sequence: 3 } } })
  const forward = read({
    direction: 'after',
    cursor: { epoch: 'epoch', sequence: 0 },
    reader: { form: 'bounded', budgetBytes: 4096 }
  })
  expect(sequences(forward)).toEqual([1])
  expect(forward.page).toMatchObject({ hasNewer: true, window: { nextCursor: { sequence: 1 } } })
})

it('windows retained image sources before reading their bodies and admits their exact reader form', () => {
  const { db, seedItem, seedSend, head, event, read } = history()
  seedSend()
  db.prepare(`UPDATE journal_submission_attempts SET facts_json=json_set(facts_json,
    '$.admission.sourcePlacement',json(?)), admission_body_json=? WHERE message_id='send'`).run(
    JSON.stringify({
      itemId: 'orca:send',
      revision: 0,
      sequence: 1,
      observedAt: 1,
      turnScope: { kind: 'thread' }
    }),
    JSON.stringify({
      kind: 'message',
      role: 'user',
      blocks: [
        { type: 'text', text: 'x'.repeat(2 * HISTORY_PAGE_CONTENT_BUDGET_BYTES) },
        { type: 'image-ref', path: '/image.png' }
      ]
    })
  )
  db.prepare(`UPDATE journal_submission_attempts SET payload_json=json_set(payload_json,
    '$.keptAsQueuedMessageId',?) WHERE message_id='send'`).run('card'.repeat(4096))
  db.exec("UPDATE journal_items SET hidden=1 WHERE item_id='orca:send'")
  for (let sequence = 2; sequence <= 5; sequence++) {
    seedItem(text(sequence, 'visible'))
    event(sequence, sequence === 3 ? ['orca:send'] : [`orca:${sequence}:0`])
  }
  head(5, 1)
  const reader = {
    form: 'client' as const,
    budgetBytes: HISTORY_PAGE_CONTENT_BUDGET_BYTES + 4096,
    queuedImages: { ids: [['send', true] as const], imageIds: ['send'] }
  }
  const original = db
    .prepare("SELECT admission_body_json FROM journal_submission_attempts WHERE message_id='send'")
    .get()!.admission_body_json
  db.exec(
    "UPDATE journal_submission_attempts SET admission_body_json='invalid' WHERE message_id='send'"
  )
  const tail = read({ direction: 'tail', limit: 2, reader })
  expect(sequences(tail)).toEqual([4, 5])
  const middle = read({
    direction: 'before',
    cursor: tail.page.window.nextCursor,
    limit: 2,
    reader
  })
  expect(sequences(middle)).toEqual([2, 3])
  expect(middle.page.hasOlder).toBe(true)
  db.prepare(
    "UPDATE journal_submission_attempts SET admission_body_json=? WHERE message_id='send'"
  ).run(original)
  const oldest = read({
    direction: 'before',
    cursor: middle.page.window.nextCursor,
    limit: 2,
    reader
  })
  expect(oldest.page.items).toMatchObject([
    { itemId: 'orca:send', sequence: 1, shortened: true, body: { kind: 'message' } }
  ])
  expect(oldest.page.hasOlder).toBe(false)
  expect(oldest.page.submissions[0]).not.toHaveProperty('keptAsQueuedMessageId')
  const forward = read({ direction: 'after', cursor: { epoch: 'epoch', sequence: 1 }, reader })
  expect(sequences(forward)).toEqual([1, 2, 4, 5])
  expect(forward.page).toMatchObject({ hasNewer: false, window: { nextCursor: { sequence: 5 } } })
  const deferred = db
    .prepare("SELECT payload_json FROM journal_items WHERE item_id='orca:5:0'")
    .get()!.payload_json
  db.exec(
    "UPDATE journal_items SET wire_version=NULL,payload_json='excluded stale source' WHERE item_id='orca:5:0'"
  )
  const excluded = read({
    direction: 'after',
    cursor: { epoch: 'epoch', sequence: 1 },
    limit: 4,
    reader: { ...reader, budgetBytes: 4096 }
  })
  expect(sequences(excluded)).toEqual([2])
  expect(excluded.page).toMatchObject({ hasNewer: true, window: { nextCursor: { sequence: 2 } } })
  db.prepare("UPDATE journal_items SET payload_json=? WHERE item_id='orca:5:0'").run(deferred)
  const bounded = {
    ...reader,
    form: 'bounded' as const,
    budgetBytes: BOUNDED_FRAME_CONTENT_BUDGET_BYTES
  }
  expect(
    read({ direction: 'before', cursor: middle.page.window.nextCursor, reader: bounded }).page.items
  ).toMatchObject([{ itemId: 'orca:send', shortened: true, body: { kind: 'message' } }])
  expect(
    read({ direction: 'after', cursor: { epoch: 'epoch', sequence: 1 }, reader: bounded }).page
  ).toMatchObject({
    items: [{ itemId: 'orca:send' }, { sequence: 2 }, { sequence: 4 }, { sequence: 5 }],
    window: { nextCursor: { sequence: 5 } }
  })
  const presented = read(
    { direction: 'after', cursor: { epoch: 'epoch', sequence: 1 }, reader: bounded },
    {
      budgetBytes: BOUNDED_FRAME_CONTENT_BUDGET_BYTES,
      form: (item) =>
        measureHistoryItem({
          ...item,
          itemId: `reader:${item.itemId}`,
          sequence: 100 - item.sequence,
          body: { kind: 'status', text: `Presented ${item.itemId}` }
        })
    }
  )
  expect(
    presented.page.items.map(({ itemId, sequence, body }) => ({ itemId, sequence, body }))
  ).toEqual([
    {
      itemId: 'reader:orca:send',
      sequence: 99,
      body: { kind: 'status', text: 'Presented orca:send' }
    },
    {
      itemId: 'reader:orca:2:0',
      sequence: 98,
      body: { kind: 'status', text: 'Presented orca:2:0' }
    },
    {
      itemId: 'reader:orca:4:0',
      sequence: 96,
      body: { kind: 'status', text: 'Presented orca:4:0' }
    },
    {
      itemId: 'reader:orca:5:0',
      sequence: 95,
      body: { kind: 'status', text: 'Presented orca:5:0' }
    }
  ])
})

it('keeps visible rows first and retained sources in relation order across a whole boundary sequence', () => {
  const { db, seedItem, seedSend, head, read } = history()
  seedSend()
  db.prepare(`UPDATE journal_submission_attempts SET facts_json=json_set(facts_json,
    '$.admission.sourcePlacement',json(?)) WHERE message_id='send'`).run(
    JSON.stringify({
      itemId: 'orca:send',
      revision: 0,
      sequence: 7,
      sequenceIndex: 0,
      observedAt: 7,
      turnScope: { kind: 'thread' }
    })
  )
  db.exec("DELETE FROM journal_items WHERE item_id='orca:send'")
  for (const id of ['z-card', 'a-card']) {
    insertJournalDomainQueueRow(db, target, {
      messageId: id,
      position: 0,
      state: 'waiting',
      fingerprint: '',
      body: { kind: 'message', role: 'user', blocks: [{ type: 'image-ref', path: '/image.png' }] },
      queuedAt: { epoch: 'epoch', sequence: 7 },
      holdReason: null,
      returnedReason: null,
      returnedRejection: null,
      consumedAs: null
    })
  }
  seedItem(text(7, 'visible'))
  seedItem(text(8, 'tail'))
  head(8)
  const reader = {
    form: 'client' as const,
    queuedImages: {
      ids: [
        ['z-card', true],
        ['send', true],
        ['a-card', true]
      ] as const,
      imageIds: ['z-card', 'a-card']
    }
  }
  const tail = read({ direction: 'tail', limit: 1, reader })
  expect(tail.page).toMatchObject({
    items: [{ itemId: 'orca:8:0' }],
    submissions: [],
    hasOlder: true,
    hasNewer: false,
    window: { nextCursor: { sequence: 8 } }
  })
  const before = read({
    direction: 'before',
    cursor: tail.page.window.nextCursor,
    limit: 1,
    reader
  })
  expect(before.page.items.map((item) => item.itemId)).toEqual([
    'orca:7:0',
    'orca:z-card',
    'orca:send',
    'orca:a-card'
  ])
  expect(before.page).toMatchObject({
    submissions: [{ clientMessageId: 'send' }],
    hasOlder: false,
    hasNewer: true,
    window: { oldest: { sequence: 7 }, newest: { sequence: 7 }, nextCursor: { sequence: 7 } }
  })
  db.exec("UPDATE journal_submission_attempts SET dispatch_state='accepted'")
  expect(
    read({
      direction: 'before',
      cursor: tail.page.window.nextCursor,
      limit: 1,
      reader
    }).page.items.map((item) => item.itemId)
  ).toEqual(['orca:7:0', 'orca:z-card', 'orca:a-card'])
})

it('catches up with the current revision, placement and submission, not the replayed metadata', async () => {
  const { db, commit, seedSend, read } = history()
  const assertPlans = captureJournalMetadataPlans(db, 'SELECT item_id, sequence,')
  seedSend()
  db.exec(`INSERT INTO journal_submission_attempts(session_id,epoch,message_id,attempt_sequence,
    attempt_index,current,item_id,ordinal,submitted_at,accepted_sequence,fingerprint,
    dispatch_state,candidate,payload_json)
    SELECT session_id,epoch,message_id,0,0,0,item_id,0,0,NULL,fingerprint,'unknown',0,'{}'
    FROM journal_submission_attempts WHERE current=1`)
  await commit(message('first'))
  await commit(message('second'))
  const echo = message('original', 'unused', 'item')
  echo.identity = { provider: 'codex', threadId: 'thread', turnId: 'turn', ordinal: 0 }
  echo.body.role = 'user'
  await commit(echo)
  const result = read({ direction: 'after', cursor: { epoch: 'epoch', sequence: 10 } })
  expect(result).toMatchObject({
    ok: true,
    page: {
      items: [
        { itemId: 'orca:send', sequence: 7, body: { blocks: [{ text: 'original' }] } },
        {
          itemId: 'orca:assistant',
          revision: 2,
          sequence: 11,
          body: { blocks: [{ text: 'second' }] }
        }
      ],
      submissions: [{ clientMessageId: 'send', dispatchState: 'accepted', acceptedSequence: 1 }],
      window: { nextCursor: { epoch: 'epoch', sequence: 13 } },
      hasNewer: false
    }
  })
  const child = message('child work', 'child', 'item')
  child.options.agentId = 'child'
  await commit(child)
  expect(
    read({ direction: 'tail', scope: 'own-agent' }).page.items.map((item) => item.itemId)
  ).toEqual(['orca:send', 'orca:assistant'])
  expect(read({ direction: 'tail' }).page.items.map((item) => item.itemId)).toEqual([
    'orca:send',
    'orca:assistant',
    'orca:child'
  ])
  expect(assertPlans().some((sql) => sql.includes('root=1'))).toBe(true)
})

it('orders queued-image submissions independently of touched-event order', () => {
  const { db, seedItem, seedSend, head, event, read } = history()
  seedSend()
  seedItem({ ...text(8, 'early send'), itemId: 'orca:early' })
  db.exec(`INSERT INTO journal_submission_attempts(session_id,epoch,message_id,attempt_sequence,
    attempt_index,current,item_id,ordinal,submitted_at,fingerprint,dispatch_state,payload_json)
    SELECT session_id,epoch,'early',1,0,1,'orca:early',2,0,fingerprint,dispatch_state,
      json_set(payload_json,'$.clientMessageId','early','$.submittedAt',0)
    FROM journal_submission_attempts WHERE message_id='send' AND current=1`)
  event(9, ['orca:send'])
  event(10, ['orca:early'])
  head(10, 8)
  for (const queuedImages of [
    { ids: [], imageIds: [] },
    { ids: [['send', true] as const], imageIds: ['card'] }
  ]) {
    const page = read({
      direction: 'after',
      cursor: { epoch: 'epoch', sequence: 8 },
      reader: { form: 'client', queuedImages }
    })
    expect(page.page.submissions.map((send) => send.clientMessageId)).toEqual(['early', 'send'])
    expect(page.page.window.nextCursor).toEqual({ epoch: 'epoch', sequence: 10 })
  }
})

it('resets a cursor below the pruned boundary or across a gap, and resumes at the boundary', () => {
  const { db, seedItem, head, event, read } = history()
  for (let sequence = 1; sequence <= 3; sequence++) {
    seedItem(text(sequence, 'row'))
  }
  event(3, ['orca:3:0'])
  head(3, 2)
  expect(read({ direction: 'after', cursor: { epoch: 'epoch', sequence: 1 } })).toMatchObject({
    ok: false,
    reset: 'cursor_compacted',
    page: { direction: 'tail', items: [{ sequence: 1 }, { sequence: 2 }, { sequence: 3 }] }
  })
  const resumed = read({ direction: 'after', cursor: { epoch: 'epoch', sequence: 2 } })
  expect(resumed.ok).toBe(true)
  expect(sequences(resumed)).toEqual([3])
  db.exec('DELETE FROM journal_events')
  expect(read({ direction: 'after', cursor: { epoch: 'epoch', sequence: 2 } })).toMatchObject({
    ok: false,
    reset: 'journal_gap'
  })
})

it('answers every selected read from the snapshot its head came from', () => {
  const dir = mkdtempSync(join(tmpdir(), 'journal-domain-history-'))
  const path = join(dir, 'chat.db')
  const writer = new Database(path)
  writer.pragma('journal_mode=WAL')
  const { seedItem, head } = history(writer)
  seedItem(text(1, 'first'))
  seedItem({
    itemId: 'orca:turn',
    revision: 1,
    sequence: 2,
    observedAt: 2,
    body: { kind: 'turn', turnId: 'turn', state: 'running', startedAt: 2 },
    turnScope: { kind: 'thread' }
  })
  head(2)
  const reader = new Database(path, { readonly: true })
  cleanup.push(
    () => reader.close(),
    () => rmSync(dir, { recursive: true })
  )
  let wrote = false
  const result = readJournalDomainHistoryPage(
    reader,
    { sessionId: target.sessionId, direction: 'tail' },
    {
      budgetBytes: 1024 * 1024,
      form: (item) => {
        if (!wrote) {
          wrote = true
          writer.exec('DELETE FROM journal_items; UPDATE journal_chat_state SET last_sequence=9')
        }
        return measureHistoryItem(item)
      }
    }
  )
  expect(result).toMatchObject({
    ok: true,
    page: {
      items: [{ itemId: 'orca:1:0' }, { itemId: 'orca:turn' }],
      liveCursor: { epoch: 'epoch', sequence: 2 },
      latestTurn: { itemId: 'orca:turn', turn: { state: 'running' } },
      hasOlder: false
    }
  })
  expect(writer.prepare('SELECT COUNT(*) AS count FROM journal_items').get()!.count).toBe(0)
})
