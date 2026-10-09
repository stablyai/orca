import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  AGENT_SESSION_QUEUE_REPLY_MAX_BYTES,
  AGENT_SESSION_QUEUE_SUMMARY_MAX_BYTES,
  type AgentSessionQueuedMessagesPageResult
} from '../../../shared/agent-session-queue-pages'
import {
  QUEUED_MESSAGE_SOURCE_SQL,
  QUEUED_MESSAGE_UNSETTLED_SQL
} from '../agent-session-journal/queued-message-source-index'
import { JournalQueuedMessages } from '../agent-session-journal/journal-queued-messages'
import {
  PAGE_SESSION,
  pageMessage,
  queuePageRig,
  type QueuePageRig
} from './agent-session-queue-pages.test-fixture'

let rig: QueuePageRig
beforeEach(async () => {
  rig = await queuePageRig()
})
afterEach(async () => {
  vi.restoreAllMocks()
  await rig.close()
})

function page(result: AgentSessionQueuedMessagesPageResult) {
  expect(Buffer.byteLength(JSON.stringify(rig.wrapped(result)))).toBeLessThanOrEqual(
    AGENT_SESSION_QUEUE_REPLY_MAX_BYTES
  )
  if (result.status !== 'page') {
    throw new Error('unexpected queue reset')
  }
  return result
}

it('walks every tiny card in both directions, including tied positions, with a host size cap', () => {
  rig.seed(1001)
  const first = page(rig.page({ size: 100000 }))
  expect(first.rows).toHaveLength(200)
  let current = first
  const forward = first.rows.map((row) => row.messageId)
  while (current.nextCursor) {
    current = page(rig.page({ cursor: current.nextCursor, size: 137 }))
    forward.push(...current.rows.map((row) => row.messageId))
  }
  const backwards = current.rows.map((row) => row.messageId)
  while (current.previousCursor) {
    current = page(rig.page({ cursor: current.previousCursor, size: 113 }))
    backwards.unshift(...current.rows.map((row) => row.messageId))
  }
  expect(new Set(forward).size).toBe(1001)
  expect(backwards).toEqual(forward)
})

it('counts 10k rows and finds the newest person and returned blocker using indexes without hydration', () => {
  rig.seed(10000)
  rig.db
    .prepare("UPDATE queued_messages SET state = 'returned' WHERE message_id = 'card-00003'")
    .run()
  const list = vi.spyOn(JournalQueuedMessages.prototype, 'list')
  const parse = vi.spyOn(JSON, 'parse')
  const prepare = vi.spyOn(rig.db, 'prepare')
  const summary = rig.summary()
  expect(summary).toMatchObject({
    total: 10000,
    counts: { person: 10000, agent: 0, unknown: 0 },
    newestPersonMessageId: 'card-10000',
    blockingReturnedMessageId: 'card-00003',
    resumeAvailable: false
  })
  expect(Buffer.byteLength(JSON.stringify(summary))).toBeLessThanOrEqual(
    AGENT_SESSION_QUEUE_SUMMARY_MAX_BYTES
  )
  expect(parse).not.toHaveBeenCalled()
  expect(list).not.toHaveBeenCalled()
  for (const [sql] of prepare.mock.calls) {
    expect(sql.split('FROM')[0]).not.toMatch(/SELECT .*body_json|returned_rejection/)
  }
  const plan = rig.db
    .prepare(`EXPLAIN QUERY PLAN SELECT message_id FROM queued_messages
    WHERE session_id = ? AND ${QUEUED_MESSAGE_UNSETTLED_SQL} AND ${QUEUED_MESSAGE_SOURCE_SQL} = 'person'
    ORDER BY created_at DESC, position DESC, message_id DESC LIMIT 1`)
    .all(PAGE_SESSION)
  expect(plan.map((row) => row.detail).join(' ')).toContain(
    'queued_messages_unsettled_source_created'
  )
  const countPlan = rig.db
    .prepare(`EXPLAIN QUERY PLAN SELECT ${QUEUED_MESSAGE_SOURCE_SQL}, COUNT(*)
    FROM queued_messages WHERE session_id = ? AND ${QUEUED_MESSAGE_UNSETTLED_SQL}
    GROUP BY ${QUEUED_MESSAGE_SOURCE_SQL}`)
    .all(PAGE_SESSION)
  expect(countPlan.map((row) => row.detail).join(' ')).toContain(
    'queued_messages_unsettled_source_position'
  )
})

it('never counts malformed or unknown provenance as a person and anchors independently of agent backlog', async () => {
  rig.seed(300, {
    ...pageMessage('agent'),
    from: { kind: 'agent', senders: [], orchestration: null }
  })
  await rig.insert('person-newest')
  const unknown = ['null', '7', '{}', '{"kind":7}', '{"kind":"future"}']
  for (const [index, from] of unknown.entries()) {
    await rig.insert(`unknown-${index}`)
    rig.db
      .prepare('UPDATE queued_messages SET body_json = ? WHERE message_id = ?')
      .run(`{"kind":"message","role":"user","blocks":[],"from":${from}}`, `unknown-${index}`)
  }
  rig.journal.queuedMessages.invalidate()
  expect(rig.summary()).toMatchObject({
    counts: { person: 1, agent: 301, unknown: 4 },
    newestPersonMessageId: 'person-newest'
  })
  expect(
    page(rig.page({ source: 'person', aroundMessageId: 'person-newest' })).rows.map(
      (row) => row.messageId
    )
  ).toEqual(['person-newest'])
  expect(page(rig.page({ aroundMessageId: 'person-newest', size: 1 })).rows[0]?.messageId).toBe(
    'person-newest'
  )
})

it('returns a reset for a vanished, moved, foreign-filter or foreign-generation anchor', async () => {
  rig.seed(4)
  const first = page(rig.page({ size: 1 }))
  const cursor = first.nextCursor ?? ''
  expect(rig.page({ cursor, source: 'person' })).toMatchObject({
    status: 'stale',
    generation: first.generation
  })
  rig.db
    .prepare('UPDATE queued_messages SET position = 20 WHERE message_id = ?')
    .run(first.rows[0]?.messageId ?? '')
  expect(rig.page({ cursor })).toMatchObject({ status: 'stale' })
  rig.db
    .prepare('UPDATE queued_messages SET position = 0 WHERE message_id = ?')
    .run(first.rows[0]?.messageId ?? '')
  await rig.journal.queuedMessages.withdraw({
    messageIds: [first.rows[0]?.messageId ?? ''],
    settledByOp: 'op'
  })
  expect(rig.page({ cursor })).toMatchObject({ status: 'stale' })
  expect(rig.page({ aroundMessageId: 'vanished' })).toMatchObject({ status: 'stale' })
  const before = page(rig.page({ size: 1 }))
  await rig.journal.rollEpoch('handle_forked', 1)
  const reset = rig.page({ cursor: before.nextCursor ?? '' })
  expect(reset.status).toBe('stale')
  expect(reset.generation).not.toBe(before.generation)
})

it('bounds escaped previews, sender labels and failure metadata in the actual envelope, and always advances', async () => {
  const text = '\u0000"\\🦦漢'.repeat(24000)
  const body = {
    ...pageMessage(text),
    from: {
      kind: 'agent' as const,
      senders: Array.from({ length: 80 }, () => ({
        name: 'name'.repeat(1000),
        party: { address: 'address'.repeat(1000), terminalHandle: null, orcaSessionId: null }
      })),
      orchestration: {
        message: 'mail-notice' as const,
        mailbox: 'mail',
        dispatchId: null,
        messages: Array.from({ length: 1000 }, () => ({
          messageId: 'source',
          runId: 'run',
          from: 'sender'
        }))
      }
    }
  }
  rig.seed(150, body)
  rig.db
    .prepare(
      "UPDATE queued_messages SET state = 'returned', returned_reason = ?, returned_rejection = ?"
    )
    .run(
      '\u0000'.repeat(100000),
      JSON.stringify({
        kind: '\u0000'.repeat(1000),
        detail: { text, audience: 'log' },
        taskSpec: text
      })
    )
  const envelope = { id: '\u0000'.repeat(10000), runtimeId: 'runtime' }
  let current = rig.page({ size: 200 }, envelope)
  const ids = new Set<string>()
  for (;;) {
    expect(
      Buffer.byteLength(
        JSON.stringify({
          id: envelope.id,
          ok: true,
          result: current,
          _meta: { runtimeId: envelope.runtimeId }
        })
      )
    ).toBeLessThanOrEqual(AGENT_SESSION_QUEUE_REPLY_MAX_BYTES)
    if (current.status !== 'page') {
      throw new Error('unexpected reset')
    }
    expect(current.rows.length).toBeGreaterThan(0)
    for (const row of current.rows) {
      ids.add(row.messageId)
      expect(Buffer.byteLength(row.preview)).toBeLessThanOrEqual(512)
      expect(row.truncated).toBe(true)
      expect(row.senderLabels).toHaveLength(3)
      expect(row.senderCount).toBe(80)
      expect(JSON.stringify(row)).not.toContain('taskSpec')
      expect(JSON.stringify(row)).not.toContain('mailbox')
    }
    if (!current.nextCursor) {
      break
    }
    current = rig.page({ size: 200, cursor: current.nextCursor }, envelope)
  }
  expect(ids.size).toBe(150)
})

it.each([`${'a'.repeat(511)}🦦`, '漢'.repeat(171), 'é'.repeat(257), '"\\\n'.repeat(200)])(
  'cuts preview on a UTF-8 code point boundary',
  async (text) => {
    await rig.insert('unicode', pageMessage(text))
    const row = page(rig.page()).rows[0]
    expect(Buffer.byteLength(row?.preview ?? '')).toBeLessThanOrEqual(512)
    expect(text.startsWith(row?.preview ?? '')).toBe(true)
    expect(row?.preview.endsWith('\ud83e')).toBe(false)
  }
)

it('uses one short read transaction per page and releases it on a reset', () => {
  rig.seed(3)
  const exec = vi.spyOn(rig.db, 'exec')
  page(rig.page())
  expect(exec.mock.calls.map(([sql]) => sql)).toEqual(['BEGIN', 'COMMIT'])
  exec.mockClear()
  expect(rig.page({ cursor: 'invalid' }).status).toBe('stale')
  expect(exec.mock.calls.map(([sql]) => sql)).toEqual(['BEGIN', 'COMMIT'])
  expect(rig.db.isTransaction).toBe(false)
})

it('keeps the newest person shortcut tied to creation when queue order changes', async () => {
  await rig.insert('older')
  await rig.insert('newer')
  rig.db
    .prepare("UPDATE queued_messages SET created_at = 2, position = -1 WHERE message_id = 'newer'")
    .run()
  rig.db.prepare("UPDATE queued_messages SET created_at = 1 WHERE message_id = 'older'").run()
  rig.journal.queuedMessages.invalidate()
  expect(rig.summary().newestPersonMessageId).toBe('newer')
})

it('resets cursors after the same saved journal is reopened with a new handle', async () => {
  rig.seed(3)
  const first = page(rig.page({ size: 1 }))
  const epoch = rig.journal.epoch
  await rig.reopen()
  expect(rig.journal.epoch).toBe(epoch)
  expect(rig.page({ cursor: first.nextCursor ?? '' })).toMatchObject({ status: 'stale' })
  expect(rig.summary().generation).not.toBe(first.generation)
  expect(rig.summary().total).toBe(3)
})

it('walks long escaped ids both ways when the byte budget limits page size', () => {
  rig.seed(220, pageMessage('\u0000'.repeat(1000)))
  rig.db
    .prepare('UPDATE queued_messages SET message_id = message_id || ?')
    .run('\u0000'.repeat(490))
  let current = page(rig.page({ size: 200 }))
  expect(current.rows.length).toBeLessThan(200)
  const forward = current.rows.map((row) => row.messageId)
  while (current.nextCursor) {
    current = page(rig.page({ cursor: current.nextCursor, size: 200 }))
    forward.push(...current.rows.map((row) => row.messageId))
  }
  const backward = current.rows.map((row) => row.messageId)
  while (current.previousCursor) {
    current = page(rig.page({ cursor: current.previousCursor, size: 200 }))
    backward.unshift(...current.rows.map((row) => row.messageId))
  }
  expect(new Set(forward).size).toBe(220)
  expect(backward).toEqual(forward)
})

it('shrinks optional row metadata before returning an eligible first row', () => {
  rig.seed(2, pageMessage('\u0000'.repeat(1000)))
  const envelope = { id: 'x'.repeat(510 * 1024), runtimeId: 'host' }
  const result = rig.page({ size: 1 }, envelope)
  if (result.status !== 'page') {
    throw new Error('unexpected reset')
  }
  expect(result.rows).toHaveLength(1)
  expect(result.rows[0]).toMatchObject({ preview: '', truncated: true })
  expect(result.nextCursor).not.toBeNull()
  expect(
    Buffer.byteLength(
      JSON.stringify({
        id: envelope.id,
        ok: true,
        result,
        _meta: { runtimeId: envelope.runtimeId }
      })
    )
  ).toBeLessThanOrEqual(AGENT_SESSION_QUEUE_REPLY_MAX_BYTES)
})
