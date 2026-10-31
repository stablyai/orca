import { registerCodexCatchUpEchoTests } from './codex-structured-thread-catch-up-echo.spec'
import { projectStructuredItemsToNativeChat } from '../../shared/structured-agent-session-projection'
import { expect, it } from 'vitest'
import { createCodexJournalTranslator } from './codex-structured-journal-translation'

import { SESSION, THREAD, chat, turn } from './codex-thread-catch-up-contract-test-fixture'

it('retains the complete outside answer tail through catch-up, disk reopen and display', async () => {
  const c = await chat({ now: 1_000 })
  await c.open([turn(1)])
  const answer = `${'outside answer paragraph\n'.repeat(1_024)}END-OF-OUTSIDE-ANSWER-30883`
  const outside = { ...turn(2), items: [{ type: 'agentMessage', id: 'a-2', text: answer }] }
  await c.open([turn(1), outside])
  await c.reopen()
  const items = c.journal.snapshot().items
  const stored = items.find(
    (item) =>
      item.body.kind === 'message' &&
      item.body.role === 'assistant' &&
      item.body.blocks.some((block) => block.type === 'text' && block.text === answer)
  )
  expect(stored?.body).toEqual({
    kind: 'message',
    role: 'assistant',
    blocks: [{ type: 'text', text: answer }]
  })
  const displayed = projectStructuredItemsToNativeChat(items).flatMap((message) => message.blocks)
  expect(displayed).toContainEqual({ type: 'text', text: answer })
})

it('adds the turns made outside the chat once, in order, after the chat rows', async () => {
  const c = await chat({ now: 1_000 })

  await c.open([turn(1)])
  expect(c.texts()).toEqual(['user:ask 1', 'assistant:answer 1'])

  await c.open([turn(1), turn(2), turn(3)])
  const caughtUp = [
    'user:ask 1',
    'assistant:answer 1',
    '(continued-outside)',
    'user:ask 2',
    'assistant:answer 2',
    'user:ask 3',
    'assistant:answer 3'
  ]
  expect(c.texts()).toEqual(caughtUp)

  await c.open([turn(1), turn(2), turn(3)])
  expect(c.texts()).toEqual(caughtUp)

  // An external rewind preserves displayed rows and adds a notice.
  await c.open([turn(1), turn(2), turn(4)])
  expect(c.texts().slice(caughtUp.length)).toEqual([
    '(continued-outside-rewound)',
    'user:ask 4',
    'assistant:answer 4'
  ])

  // Summary-only history cannot be imported.
  await c.open([turn(1), turn(2), turn(4), turn(6, 'summary')])
  expect(c.texts().slice(caughtUp.length + 3)).toEqual([])
})

it('recovers an older gap behind newer native work after a failed read and restart', async () => {
  const c = await chat({ now: 1_000 })
  await c.open([turn(1)])
  const failed = {
    request: async () => {
      throw new Error('read failed')
    }
  }
  await c.open([turn(1), turn(2)], { connection: failed })
  const native = createCodexJournalTranslator({
    sink: c.deferred.sink,
    sessionId: SESSION,
    primaryThreadId: () => THREAD
  })
  for (const [method, params] of [
    ['turn/started', { turn: { id: 'turn-3' } }],
    [
      'item/completed',
      { turnId: 'turn-3', item: { type: 'agentMessage', id: 'native', text: 'native C' } }
    ],
    ['turn/completed', { turn: { id: 'turn-3', status: 'completed' } }]
  ] as const) {
    native.handle({ type: 'notification', sessionId: SESSION, threadId: THREAD, method, params })
  }
  await c.deferred.drained()
  native.dispose()
  const before = c.journal.snapshot().items
  await c.reopen()
  await c.open([turn(1), turn(2), turn(3)])
  expect(c.journal.snapshot().items.slice(0, before.length)).toEqual(before)
  expect(c.texts().slice(-3)).toEqual(['(continued-outside)', 'user:ask 2', 'assistant:answer 2'])
  await c.open([turn(1), turn(2), turn(3), turn(4)])
  expect(c.texts().slice(-3)).toEqual(['(continued-outside)', 'user:ask 4', 'assistant:answer 4'])
})

it('uses the continued-outside notice after a receipt-only known turn', async () => {
  const c = await chat({ now: 1_000 })
  const body = { kind: 'message' as const, role: 'user' as const, blocks: [] }
  await c.journal.appendSubmission({
    clientMessageId: 'receipt',
    body,
    payloadFingerprint: 'receipt',
    fence: 1
  })
  await c.journal.resolveDispatch({
    clientMessageId: 'receipt',
    state: 'accepted',
    providerIdentity: { provider: 'codex', threadId: THREAD, turnId: 'turn-1', ordinal: 0 },
    fence: 1
  })
  await c.open([turn(1), turn(2)])
  expect(c.texts().slice(-3)).toEqual(['(continued-outside)', 'user:ask 2', 'assistant:answer 2'])
})

it('commits a 600-message import once, rolls back a later partition failure, and recovers', async () => {
  const c = await chat({ now: 1_000 })
  await c.open([turn(1)])
  const before = c.journal.snapshot()
  const large = {
    ...turn(2),
    items: Array.from({ length: 600 }, (_, n) => ({
      type: 'agentMessage',
      id: `item-${n}`,
      text: `answer ${n}`
    }))
  }
  const seq = c.journal.cursor().sequence
  c.db.exec(
    `CREATE TRIGGER fail_later_partition BEFORE INSERT ON journal_rows WHEN NEW.seq > ${seq + 1} BEGIN SELECT RAISE(ABORT, 'injected later partition failure'); END`
  )
  expect((await c.open([turn(1), large])).ok).toBe(false)
  expect(c.deferred.state().failed).toBe(true)
  expect(c.journal.snapshot()).toEqual(before)
  c.db.exec('DROP TRIGGER fail_later_partition')
  await c.reopen()
  expect(c.journal.snapshot()).toEqual(before)
  c.publications.length = 0
  await c.open([turn(1), large])
  expect(c.texts()).toHaveLength(603)
  expect(c.publications).toEqual([before.items.length + 602])
  await c.reopen()
  await c.open([turn(1), large])
  expect(c.texts()).toHaveLength(603)
})

it('keeps rollback reasoning and message identities immutable across turns', async () => {
  const c = await chat({ now: 1_000 })
  const withReasoning = (n: number) => ({
    ...turn(n),
    items: [
      { type: 'reasoning', id: 'item-2', summary: [{ text: `reason ${n}` }] },
      { type: 'agentMessage', id: 'same-message-id', text: `answer ${n}` }
    ]
  })
  await c.open([withReasoning(1)])
  const before = c.journal.snapshot().items
  await c.open([withReasoning(2)])
  expect(c.journal.snapshot().items.slice(0, before.length)).toEqual(before)
  expect(c.texts().filter((text) => text.startsWith('assistant:'))).toEqual([
    'assistant:answer 1',
    'assistant:answer 2'
  ])
  const reasoning = c.journal
    .snapshot()
    .items.filter((item) => item.body.kind === 'message' && item.body.role === 'reasoning')
  expect(new Set(reasoning.map((item) => item.itemId)).size).toBe(2)
  expect(new Set(reasoning.map((item) => JSON.stringify(item.turnScope))).size).toBe(2)
})

export { chat, turn } from './codex-thread-catch-up-contract-test-fixture'

registerCodexCatchUpEchoTests({ chat, turn, sessionId: SESSION, threadId: THREAD })
