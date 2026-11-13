import { saveJournalDomainOutlineCache } from './journal-domain-outline'
import { afterEach, expect, it } from 'vitest'
import {
  domainLifecycleFixture,
  lifecycleIdentity as identity,
  lifecycleOptions as options
} from './journal-domain-lifecycle.test-fixture'
import { readJournalSqlPoint } from './journal-sql-point-read'
import { journalSqlReads } from './journal-sql-reads'
import { insertJournalDomainQueueRow } from './journal-domain-queue-rows'
import { resolveChatAutomationRun } from '../../automations/observation/automation-chat-run-observation'
import type { AgentJournalMessageItem } from '../../../shared/agent-session/journal/agent-session-journal-types'

const cleanup: (() => void)[] = []
afterEach(() => cleanup.splice(0).forEach((close) => close()))
const body = (text: string): AgentJournalMessageItem => ({
  kind: 'message',
  role: 'user',
  blocks: [{ type: 'text', text }]
})
const readsOf = (f: ReturnType<typeof domainLifecycleFixture>) =>
  journalSqlReads({ point: async (request) => readJournalSqlPoint(f.db, request) }, 'chat')

it('keeps a fork validation current through streaming but invalidates a send and its later settlement', async () => {
  const f = domainLifecycleFixture(cleanup)
  const reads = readsOf(f)
  await f.run({
    kind: 'submission',
    input: {
      clientMessageId: 'unrelated',
      fence: 1,
      body: body('Old send'),
      payloadFingerprint: 'old'
    }
  })
  await f.run({
    kind: 'item',
    identity: identity('selected'),
    body: { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'Saved reply' }] },
    options
  })
  const boundary = () => reads.forkBoundary('orca:selected', undefined, true)
  const original = await boundary()
  await f.run({
    kind: 'item',
    identity: identity('stream'),
    body: { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'Streaming' }] },
    options
  })
  expect((await boundary()).submissionsToken).toBe(original.submissionsToken)
  await f.run({
    kind: 'submission',
    input: {
      clientMessageId: 'send',
      fence: 1,
      body: body('New request'),
      payloadFingerprint: 'send'
    }
  })
  const admitted = await boundary()
  expect(admitted.submissionsToken).not.toBe(original.submissionsToken)
  await f.run({
    kind: 'dispatch',
    input: {
      clientMessageId: 'send',
      fence: 1,
      state: 'accepted',
      providerIdentity: { provider: 'claude', sessionId: 'provider', uuid: 'echo' }
    }
  })
  const accepted = await boundary()
  expect(accepted.submissionsToken).not.toBe(admitted.submissionsToken)
  // Unrelated old dispatch data is not needed to validate the selected response.
  f.db
    .prepare(
      "UPDATE journal_submission_attempts SET payload_json='unreadable historical send' WHERE message_id='unrelated'"
    )
    .run()
  expect((await boundary()).submissionsToken).toBe(accepted.submissionsToken)
})

it('keeps tool echoes and harness sidecars out of the outline across neighbouring assistant rows', async () => {
  const f = domainLifecycleFixture(cleanup)
  const reads = readsOf(f)
  await f.run({ kind: 'item', identity: identity('prompt'), body: body('Real prompt'), options })
  await f.run({
    kind: 'item',
    identity: identity('turn'),
    options,
    body: { kind: 'turn', turnId: 'turn', state: 'running', userItemId: 'orca:prompt' }
  })
  const scoped = { ...options, turnScope: { kind: 'turn' as const, turnItemId: 'orca:turn' } }
  await f.run({
    kind: 'item',
    identity: identity('answer'),
    options: scoped,
    body: {
      kind: 'message',
      role: 'assistant',
      blocks: [
        { type: 'text', text: 'Answer' },
        { type: 'tool-call', callId: 'read', name: 'Read', input: 'x' }
      ]
    }
  })
  await f.run({
    kind: 'item',
    identity: identity('echo'),
    options: scoped,
    body: {
      kind: 'message',
      role: 'user',
      blocks: [{ type: 'tool-result', callId: 'read', output: 'Large output' }]
    }
  })
  await f.run({
    kind: 'item',
    identity: identity('tool-pair'),
    options: scoped,
    body: {
      kind: 'message',
      role: 'user',
      blocks: [
        { type: 'tool-call', callId: 'other', name: 'Read', input: 'y' },
        { type: 'tool-result', callId: 'other', output: 'More output' }
      ]
    }
  })
  await f.run({
    kind: 'item',
    identity: identity('sidecar'),
    options: scoped,
    body: {
      kind: 'message',
      role: 'user',
      blocks: [
        { type: 'text', text: '<system-reminder>Injected context</system-reminder>' },
        { type: 'tool-result', callId: 'read', output: 'Background result' }
      ]
    }
  })
  await f.run({
    kind: 'item',
    identity: identity('worker-mail'),
    options: scoped,
    body: {
      ...body('Worker report'),
      from: { kind: 'agent', senders: [], orchestration: null }
    }
  })
  const outline = await reads.conversationOutline(100_000)
  expect(outline.humanMessagesOnly).toBe(true)
  expect(outline.entries).toEqual([
    { itemId: 'orca:prompt', sequence: 1, preview: 'Real prompt', imageCount: 0, reply: 'Answer' }
  ])
})

it('reads outline prompts and the last useful reply for their owning turn without loading other bodies', async () => {
  const f = domainLifecycleFixture(cleanup)
  const reads = readsOf(f)
  await f.run({ kind: 'item', identity: identity('prompt'), body: body('First request'), options })
  await f.run({
    kind: 'item',
    identity: identity('turn'),
    body: { kind: 'turn', turnId: 'turn', state: 'running', userItemId: 'orca:prompt' },
    options
  })
  const scope = { ...options, turnScope: { kind: 'turn' as const, turnItemId: 'orca:turn' } }
  for (const [id, text] of [
    ['old', 'Old reply'],
    ['reply', '**Saved answer**'],
    ['code', '```ts\nconst x = 1\n```']
  ]) {
    await f.run({
      kind: 'item',
      identity: identity(id),
      body: { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text }] },
      options: scope
    })
  }
  await f.run({
    kind: 'item',
    identity: identity('steer'),
    body: body('Follow up'),
    options: scope
  })
  await f.run({
    kind: 'item',
    identity: identity('tool'),
    body: { kind: 'tool-call', callId: 'call', name: 'Read', input: 'file', state: 'completed' },
    options: scope
  })
  await f.run({
    kind: 'item',
    identity: identity('child'),
    body: body('Child request'),
    options: { ...scope, agentId: 'child' }
  })
  f.db
    .prepare(`UPDATE journal_items SET payload_json='unrelated body must not be decoded'
    WHERE item_id IN ('orca:old','orca:tool','orca:child')`)
    .run()
  const outline = await reads.conversationOutline(100_000)
  expect(outline.entries).toEqual([
    {
      itemId: 'orca:prompt',
      sequence: 1,
      preview: 'First request',
      imageCount: 0,
      reply: 'Saved answer'
    },
    {
      itemId: 'orca:steer',
      sequence: 6,
      preview: 'Follow up',
      imageCount: 0,
      turnKey: 'orca:prompt',
      reply: 'Saved answer'
    }
  ])
  expect(outline.omittedEntries).toBe(0)
  await f.run({
    kind: 'steps',
    steps: [
      {
        kind: 'resolved-item',
        reservedBytes: 4096,
        options: scope,
        resolution: {
          kind: 'text-snapshot',
          identity: identity('reply'),
          body: {
            kind: 'message',
            role: 'assistant',
            blocks: [{ type: 'text', text: '**Updated answer**' }]
          }
        }
      }
    ]
  })
  expect((await reads.conversationOutline(100_000)).entries.map((entry) => entry.reply)).toEqual([
    'Updated answer',
    'Updated answer'
  ])
  await f.run({ kind: 'tombstone', identity: identity('reply'), fence: 1 })
  expect((await reads.conversationOutline(100_000)).entries.map((entry) => entry.reply)).toEqual([
    'Old reply',
    'Old reply'
  ])
  f.db.prepare("UPDATE journal_items SET payload_json='originals are not outline inputs'").run()
  f.reopen()
  expect((await reads.conversationOutline(100_000)).entries).toEqual([
    {
      itemId: 'orca:prompt',
      sequence: 1,
      preview: 'First request',
      imageCount: 0,
      reply: 'Old reply'
    },
    {
      itemId: 'orca:steer',
      sequence: 6,
      preview: 'Follow up',
      imageCount: 0,
      turnKey: 'orca:prompt',
      reply: 'Old reply'
    }
  ])
})

it('degrades all outline previews before omitting the oldest entries', async () => {
  const f = domainLifecycleFixture(cleanup)
  const reads = readsOf(f)
  for (const id of ['first', 'second']) {
    await f.run({ kind: 'item', identity: identity(id), options, body: body('x'.repeat(1_000)) })
    await f.run({
      kind: 'item',
      identity: identity(`${id}-turn`),
      options,
      body: { kind: 'turn', turnId: `${id}-turn`, state: 'running', userItemId: `orca:${id}` }
    })
    await f.run({
      kind: 'item',
      identity: identity(`${id}-reply`),
      options: { ...options, turnScope: { kind: 'turn', turnItemId: `orca:${id}-turn` } },
      body: {
        kind: 'message',
        role: 'assistant',
        blocks: [{ type: 'text', text: 'a'.repeat(1_000) }]
      }
    })
  }
  expect(
    (await reads.conversationOutline(700)).entries.map(({ preview, reply }) => ({ preview, reply }))
  ).toEqual([
    { preview: 'x'.repeat(200), reply: undefined },
    { preview: 'x'.repeat(200), reply: undefined }
  ])
  expect((await reads.conversationOutline(350)).entries.map((entry) => entry.preview)).toEqual([
    'x'.repeat(60),
    'x'.repeat(60)
  ])
  expect((await reads.conversationOutline(170)).entries.map((entry) => entry.preview)).toEqual([
    '',
    ''
  ])
  expect(await reads.conversationOutline(100)).toMatchObject({
    entries: [{ itemId: 'orca:second', preview: '', imageCount: 0 }],
    omittedEntries: 1
  })
})

it('names only the sole eligible current prompt automatically and keeps manual naming after another prompt', async () => {
  const f = domainLifecycleFixture(cleanup)
  const reads = readsOf(f)
  await f.run({ kind: 'item', identity: identity('old'), body: body('Old request'), options })
  await f.run({
    kind: 'item',
    identity: identity('clear'),
    body: {
      kind: 'status',
      text: 'Cleared',
      contextClear: { operationId: 'clear', afterFence: 1, clearedAt: 1 }
    },
    options
  })
  await f.run({
    kind: 'submission',
    input: {
      clientMessageId: 'send',
      fence: 1,
      body: body('Current request'),
      payloadFingerprint: 'prompt',
      handoverRecorded: true
    }
  })
  await f.run({
    kind: 'dispatch',
    input: {
      clientMessageId: 'send',
      fence: 1,
      state: 'accepted',
      providerIdentity: { provider: 'claude', sessionId: 'provider', uuid: 'echo' }
    }
  })
  await f.run({
    kind: 'item',
    identity: identity('child'),
    body: body('Child request'),
    options: { ...options, agentId: 'child' }
  })
  expect(await reads.namingPrompt(100)).toBe('Current request')
  expect(await reads.namingPrompt(101)).toBe('')
  // Imported provider presentation can retain its source identity and exact alias.
  f.db
    .prepare(
      `UPDATE journal_items SET item_id='claude:provider:echo',payload_json=replace(payload_json,'orca:send','claude:provider:echo') WHERE item_id='orca:send'`
    )
    .run()
  expect(await reads.namingPrompt(100)).toBe('Current request')
  await f.run({
    kind: 'item',
    identity: identity('second'),
    body: body('Another request'),
    options
  })
  expect(await reads.namingPrompt(100)).toBe('')
  expect(await reads.namingPrompt()).toBe('Current request')
})

it('observes a consumed automation card through its first root turn and only that turns root output', async () => {
  const f = domainLifecycleFixture(cleanup)
  const reads = readsOf(f)
  insertJournalDomainQueueRow(
    f.db,
    { sessionId: 'chat', epoch: 'epoch' },
    {
      messageId: 'card',
      body: body('Run this'),
      position: 1,
      fingerprint: 'run',
      state: 'dispatched',
      holdReason: null,
      returnedReason: null,
      returnedRejection: null,
      consumedAs: 'send',
      queuedAt: { epoch: 'epoch', sequence: 1 }
    }
  )
  await f.run({
    kind: 'submission',
    input: { clientMessageId: 'send', fence: 1, body: body('Run this'), payloadFingerprint: 'run' }
  })
  await f.run({
    kind: 'dispatch',
    input: {
      clientMessageId: 'send',
      fence: 1,
      state: 'accepted',
      providerIdentity: { provider: 'claude', sessionId: 'provider', uuid: 'echo' }
    }
  })
  await f.run({
    kind: 'item',
    identity: identity('first'),
    body: {
      kind: 'turn',
      turnId: 'first',
      state: 'completed',
      outcome: 'success',
      userItemId: 'claude:provider:echo'
    },
    options
  })
  await f.run({
    kind: 'item',
    identity: identity('later'),
    body: { kind: 'turn', turnId: 'later', state: 'running', userItemId: 'orca:send' },
    options
  })
  const assistant = {
    kind: 'message',
    role: 'assistant',
    blocks: [{ type: 'text', text: 'Result' }]
  } as const
  await f.run({
    kind: 'item',
    identity: identity('output'),
    body: { ...assistant, blocks: [...assistant.blocks] },
    options: { fence: 1, turnScope: { kind: 'turn', turnItemId: 'orca:first' } }
  })
  await f.run({
    kind: 'item',
    identity: identity('child-output'),
    body: { ...assistant, blocks: [...assistant.blocks] },
    options: { fence: 1, agentId: 'child', turnScope: { kind: 'turn', turnItemId: 'orca:first' } }
  })
  await f.run({ kind: 'item', identity: identity('unrelated'), body: body('Unrelated'), options })
  f.db
    .prepare(
      `UPDATE journal_items SET payload_json='unreadable unrelated history' WHERE item_id='orca:unrelated'`
    )
    .run()
  const snapshot = await reads.automationRun('card', [])
  expect(snapshot.submissions.map((send) => send.clientMessageId)).toEqual(['send'])
  expect(snapshot.items.map((item) => item.itemId)).toEqual(['orca:first', 'orca:output'])
  const queued = { clientMessageId: 'card', submission: snapshot.submissions[0] }
  expect(resolveChatAutomationRun(snapshot, 'card', 'Codex', queued).observation).toMatchObject({
    status: 'completed',
    outputSnapshot: { content: 'Result', format: 'plain_text', truncated: false },
    error: null
  })
})

it('reuses a saved outline after reopen and refuses a cache result from an older source', async () => {
  const f = domainLifecycleFixture(cleanup)
  await f.run({
    kind: 'item',
    identity: identity('prompt'),
    body: body('Original prompt'),
    options
  })
  const read = () => {
    const result = readJournalSqlPoint(f.db, {
      sessionId: 'chat',
      operation: { kind: 'conversation-outline', budgetBytes: 100_000 }
    })
    if (result.kind !== 'conversation-outline') {
      throw new Error('outline unavailable')
    }
    return result
  }
  const cold = read()
  if (!cold.cache) {
    throw new Error('cold outline unavailable')
  }
  expect(saveJournalDomainOutlineCache(f.db, cold.cache)).toBe(true)
  const source = f.db
    .prepare("SELECT outline_source_json FROM journal_items WHERE item_id='orca:prompt'")
    .get()!.outline_source_json
  f.db
    .prepare(
      "UPDATE journal_items SET outline_source_json='unreadable source' WHERE item_id='orca:prompt'"
    )
    .run()
  f.reopen()
  expect(read().outline.entries).toEqual([
    { itemId: 'orca:prompt', sequence: 1, preview: 'Original prompt', imageCount: 0 }
  ])
  f.db
    .prepare("UPDATE journal_items SET outline_source_json=? WHERE item_id='orca:prompt'")
    .run(source)
  await f.run({ kind: 'item', identity: identity('later'), body: body('Changed prompt'), options })
  expect(saveJournalDomainOutlineCache(f.db, cold.cache)).toBe(false)
  const changed = read()
  expect(changed.outline.entries).toEqual([
    { itemId: 'orca:prompt', sequence: 1, preview: 'Original prompt', imageCount: 0 },
    { itemId: 'orca:later', sequence: 2, preview: 'Changed prompt', imageCount: 0 }
  ])
  await f.run({
    kind: 'item',
    identity: identity('turn'),
    options,
    body: {
      kind: 'turn',
      turnId: 'turn',
      state: 'running',
      startedAt: 10,
      userItemId: 'orca:prompt'
    }
  })
  const running = read()
  if (!running.cache) {
    throw new Error('running outline unavailable')
  }
  expect(saveJournalDomainOutlineCache(f.db, running.cache)).toBe(false)
  await f.run({
    kind: 'item',
    identity: identity('turn'),
    options,
    body: {
      kind: 'turn',
      turnId: 'turn',
      state: 'completed',
      startedAt: 10,
      completedAt: 20,
      userItemId: 'orca:prompt'
    }
  })
  const idle = read()
  if (!idle.cache) {
    throw new Error('idle outline unavailable')
  }
  expect(saveJournalDomainOutlineCache(f.db, idle.cache)).toBe(true)
  f.reopen()
  expect(read().outline).toEqual(idle.outline)
})
