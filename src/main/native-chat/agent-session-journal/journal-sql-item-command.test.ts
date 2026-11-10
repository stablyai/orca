import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import {
  domainLifecycleFixture,
  lifecycleFacts as facts,
  lifecycleIdentity as identity,
  lifecycleOptions as options
} from './journal-domain-lifecycle.test-fixture'
import { readJournalDomainHistoryPage } from './journal-domain-history-page'
import { ensureAgentSessionAttachmentClaimTables } from '../agent-session-attachments/agent-session-attachment-claims'
import { agentSessionAttachmentStoreRoot } from '../agent-session-attachments/agent-session-attachment-references'
import { ensureCommandReceiptsTable } from './writing/command-receipt-schema'

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) {
    cleanup()
  }
})

it('keeps a completed turn while dropping its unusable context annotation before admission', async () => {
  const f = domainLifecycleFixture(cleanups)
  await f.run({
    kind: 'item',
    identity: identity('turn'),
    body: {
      kind: 'turn',
      turnId: 'turn',
      state: 'completed',
      contextUsage: { window: { tokens: 0, capturedAt: 0 } }
    },
    options
  })
  expect(f.item('orca:turn')?.body).toEqual({
    kind: 'turn',
    turnId: 'turn',
    state: 'completed'
  })
})

it('publishes and binds ordinary writes to the same public epoch as history after replacement', async () => {
  const f = domainLifecycleFixture(cleanups)
  f.db.exec(`INSERT INTO agent_session_records VALUES('chat','{}')`)
  ensureCommandReceiptsTable(f.db)
  await f.run({
    kind: 'item',
    identity: identity('before'),
    body: { kind: 'status', text: 'before' },
    options
  })
  const replaced = await f.run({
    kind: 'epoch-replace',
    reason: 'legacy_import',
    fence: 1,
    items: []
  })
  expect(replaced.cursor.epoch).toBe(
    'context-v1:2cb86f27aabffce457946e9c46bd5d771895f95d6379dee0866d667e0ecb7adc'
  )
  const result = await f.run(
    {
      kind: 'item',
      identity: identity('after'),
      body: { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'after' }] },
      options
    },
    facts,
    [
      {
        kind: 'receipt',
        scope: { kind: 'caller', callerKey: 'caller' },
        receipt: {
          operationId: 'op',
          sessionId: 'chat',
          callerKey: 'caller',
          method: 'send',
          fingerprint: 'op',
          acceptedAt: 100,
          status: 'accepted',
          result: { kind: 'journal-row', epoch: 'placeholder', sequence: 1 }
        },
        row: { at: 'last', kinds: ['item'], answer: 'journal-row' }
      }
    ]
  )
  expect(result.cursor).toEqual({
    epoch: 'context-v1:2cb86f27aabffce457946e9c46bd5d771895f95d6379dee0866d667e0ecb7adc',
    sequence: 3
  })
  expect(result.value).toMatchObject({
    cursor: {
      epoch: 'context-v1:2cb86f27aabffce457946e9c46bd5d771895f95d6379dee0866d667e0ecb7adc',
      sequence: 3
    }
  })
  expect(result.effects).toMatchObject([
    {
      receipt: {
        result: {
          kind: 'journal-row',
          epoch: 'context-v1:2cb86f27aabffce457946e9c46bd5d771895f95d6379dee0866d667e0ecb7adc',
          sequence: 3
        }
      }
    }
  ])
  expect(
    JSON.parse(
      String(
        f.db.prepare(`SELECT result_json FROM agent_session_command_receipts`).get()!.result_json
      )
    )
  ).toEqual({
    kind: 'journal-row',
    epoch: 'context-v1:2cb86f27aabffce457946e9c46bd5d771895f95d6379dee0866d667e0ecb7adc',
    sequence: 3
  })
  expect(f.db.prepare(`SELECT DISTINCT epoch FROM journal_events`).all()).toEqual([
    { epoch: 'epoch' }
  ])
  expect(
    readJournalDomainHistoryPage(f.db, { sessionId: 'chat', direction: 'tail', limit: 10 }).page
      .liveCursor
  ).toEqual({
    epoch: 'context-v1:2cb86f27aabffce457946e9c46bd5d771895f95d6379dee0866d667e0ecb7adc',
    sequence: 3
  })
})

it.each(['item', 'queue'] as const)(
  'keeps goal attachments used by an independent %s when withdrawing the goal',
  async (use) => {
    const f = domainLifecycleFixture(cleanups)
    ensureAgentSessionAttachmentClaimTables(f.db)
    const upload = '10000000-0000-4000-8000-000000000001'
    const root = agentSessionAttachmentStoreRoot(f.directory)
    const file = join(root, upload, 'pasted.txt')
    const body = {
      kind: 'message' as const,
      role: 'user' as const,
      sentAs: 'goal' as const,
      blocks: [{ type: 'text' as const, text: file }]
    }
    const operation = { kind: 'item-claiming' as const, identity: identity('goal'), body, options }
    await expect(f.run(operation)).rejects.toThrow('no longer stored')
    expect(f.item('orca:goal')).toBeUndefined()
    mkdirSync(join(root, upload), { recursive: true })
    writeFileSync(file, 'attachment')
    f.db.prepare(`INSERT INTO agent_session_attachment_sweeps VALUES(?,50)`).run(upload)
    await expect(f.run(operation)).rejects.toThrow('no longer stored')
    expect(f.item('orca:goal')).toBeUndefined()
    expect(f.db.prepare(`SELECT last_sequence FROM journal_chat_state`).get()).toEqual({
      last_sequence: 0
    })
    f.db.prepare(`DELETE FROM agent_session_attachment_sweeps WHERE upload_id=?`).run(upload)
    const committed = await f.run(operation)
    expect(committed.goals).toEqual({
      uploads: [[upload, ['orca:goal']]],
      goals: [['orca:goal', [upload]]]
    })
    expect(committed.publication?.referencedUploads).toEqual([upload])
    expect(
      f.db.prepare(`SELECT upload_id,session_id FROM agent_session_attachment_claims`).all()
    ).toEqual([{ upload_id: upload, session_id: 'chat' }])
    const independent = await f.run(
      use === 'item'
        ? {
            kind: 'item',
            identity: identity('independent'),
            body: { ...body, sentAs: undefined },
            options
          }
        : {
            kind: 'queue-insert',
            input: { messageId: 'independent', body: { ...body, sentAs: undefined } }
          },
      { ...facts, goals: committed.goals }
    )
    const withdrawn = await f.run(
      { kind: 'goal-withdraw', identity: identity('goal'), fence: 1 },
      { ...facts, goals: independent.goals }
    )
    expect(withdrawn.goals).toEqual({ uploads: [], goals: [] })
    expect(f.item('orca:goal')).toBeUndefined()
    expect(f.db.prepare(`SELECT upload_id FROM agent_session_attachment_claims`).all()).toEqual([
      { upload_id: upload }
    ])
  }
)

it('withdraws a goal and its exclusive attachment claim in the writer transaction', async () => {
  const f = domainLifecycleFixture(cleanups)
  ensureAgentSessionAttachmentClaimTables(f.db)
  const upload = '10000000-0000-4000-8000-000000000002'
  const root = join(agentSessionAttachmentStoreRoot(f.directory), upload)
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, 'pasted.txt'), 'attachment')
  const goal = await f.run({
    kind: 'item-claiming',
    identity: identity('goal'),
    options,
    body: {
      kind: 'message',
      role: 'user',
      sentAs: 'goal',
      blocks: [{ type: 'text', text: join(root, 'pasted.txt') }]
    }
  })
  await f.run(
    { kind: 'goal-withdraw', identity: identity('goal'), fence: 1 },
    { ...facts, goals: goal.goals }
  )
  expect(f.item('orca:goal')).toBeUndefined()
  expect(f.db.prepare(`SELECT upload_id FROM agent_session_attachment_claims`).all()).toEqual([])
})
