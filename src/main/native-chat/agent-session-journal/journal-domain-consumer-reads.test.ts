import { afterEach, expect, it } from 'vitest'
import {
  domainLifecycleFixture,
  lifecycleIdentity as identity,
  lifecycleOptions as options
} from './journal-domain-lifecycle.test-fixture'
import { readJournalSqlPoint } from './journal-sql-point-read'
import { journalSqlReads } from './journal-sql-reads'
import { insertJournalDomainQueueRow } from './journal-domain-queue-rows'
import { resolveChatAutomationRun } from '../../automations/automation-chat-run-observation'
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
