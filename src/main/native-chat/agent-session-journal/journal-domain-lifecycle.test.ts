import { afterEach, expect, it } from 'vitest'
import {
  domainLifecycleFixture,
  lifecycleIdentity as identity,
  lifecycleOptions as options,
  lifecycleFacts
} from './journal-domain-lifecycle.test-fixture'
import type { JournalLifecycleMutationInput } from './writing/journal-lifecycle-mutation'
import { agentSessionFailureWords } from '../../../shared/agent-session/failures/agent-session-failure-words'
import { journalDomainQueueRow } from './journal-domain-queue-rows'

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) {
    cleanup()
  }
})
const status = (id: string): JournalLifecycleMutationInput => ({
  kind: 'item',
  identity: identity(id),
  body: { kind: 'status', text: id },
  turnScope: { kind: 'thread' }
})

it('settles only the named Stop turn at the writer position and reports unopened turns', async () => {
  const f = domainLifecycleFixture(cleanups)
  for (const id of ['target', 'other']) {
    await f.run({
      kind: 'item',
      identity: identity(id),
      body: { kind: 'turn', turnId: id, state: 'running' },
      options
    })
  }
  const settle = (turnId: string) =>
    f.run({
      kind: 'lifecycle',
      input: { settlementId: `stop-settled:${turnId}`, fence: 1, mutations: [] },
      takenStop: { turnId, completedAt: 300 }
    })
  expect((await settle('missing')).value).toBe(false)
  expect((await settle('target')).value).toBe(true)
  expect(f.item('orca:target')?.body).toMatchObject({ state: 'interrupted', completedAt: 300 })
  expect(f.item('orca:other')?.body).toMatchObject({ state: 'running' })
  expect((await settle('target')).publication?.items).toEqual([])
})

it('publishes complete lifecycle groups and preserves revised placement and durable retry authority', async () => {
  const f = domainLifecycleFixture(cleanups)
  await f.run({
    kind: 'item',
    identity: identity('first'),
    body: { kind: 'status', text: 'original' },
    options
  })
  const first = f.item('orca:first')!
  const result = await f.run({
    kind: 'lifecycle',
    input: {
      settlementId: 'many',
      fence: 1,
      mutations: [
        status('first'),
        ...Array.from({ length: 200 }, (_, index) => status(`row-${index}`))
      ]
    }
  })
  expect(result.value).toEqual({ epoch: 'epoch', sequence: 3 })
  expect(f.item('orca:first')).toMatchObject({
    revision: 2,
    sequence: first.sequence,
    observedAt: first.observedAt,
    body: { text: 'first' }
  })
  expect(f.item('orca:row-198')).toMatchObject({ sequence: 2, sequenceIndex: 199 })
  expect(f.item('orca:row-199')).toMatchObject({ sequence: 3 })
  expect(result.publication?.invalidatedItemIds).toContain('orca:first')
  f.reopen()
  const duplicate = await f.run({
    kind: 'lifecycle',
    input: { settlementId: 'many', fence: 1, mutations: [status('should-never-appear')] }
  })
  expect(duplicate.publication?.items).toEqual([])
  expect(f.item('orca:should-never-appear')).toBeUndefined()
  await f.run({
    kind: 'lifecycle',
    input: {
      settlementId: 'remove-turn',
      fence: 1,
      mutations: [{ kind: 'tombstone', identity: identity('first') }]
    }
  })
  const restored = await f.run({
    kind: 'item',
    identity: identity('first'),
    body: { kind: 'status', text: 'restored' },
    options
  })
  expect(restored.value).toMatchObject({ revision: 4 })
})

it('publishes a same-command revival as current and a later tombstone as removed', async () => {
  const f = domainLifecycleFixture(cleanups)
  await f.run({
    kind: 'item',
    identity: identity('revived'),
    body: { kind: 'status', text: 'before' },
    options
  })
  const revived = await f.run({
    kind: 'lifecycle',
    input: {
      settlementId: 'revival',
      fence: 1,
      mutations: [{ kind: 'tombstone', identity: identity('revived') }, status('revived')]
    }
  })
  expect(revived.publication?.removedItemIds).toEqual([])
  expect(revived.publication?.items).toMatchObject([{ itemId: 'orca:revived', revision: 3 }])
  const removed = await f.run({
    kind: 'lifecycle',
    input: {
      settlementId: 'removal',
      fence: 1,
      mutations: [status('revived'), { kind: 'tombstone', identity: identity('revived') }]
    }
  })
  expect(removed.publication?.items).toEqual([])
  expect(removed.publication?.removedItemIds).toEqual(['orca:revived'])
})

it('rolls back the entire lifecycle mutation group and its receipt if any write fails', async () => {
  const f = domainLifecycleFixture(cleanups)
  f.db.exec(
    `CREATE TRIGGER refuse_item BEFORE INSERT ON journal_items WHEN NEW.item_id='orca:refuse' BEGIN SELECT RAISE(ABORT,'refused'); END`
  )
  await expect(
    f.run({
      kind: 'lifecycle',
      input: { settlementId: 'retry', fence: 1, mutations: [status('prefix'), status('refuse')] }
    })
  ).rejects.toThrow('refused')
  expect(f.item('orca:prefix')).toBeUndefined()
  f.db.exec('DROP TRIGGER refuse_item')
  const retried = await f.run({
    kind: 'lifecycle',
    input: { settlementId: 'retry', fence: 1, mutations: [status('prefix')] }
  })
  expect(retried.publication?.items).toMatchObject([{ itemId: 'orca:prefix', revision: 1 }])
})

it('retains settlement retry authority after more than 4096 unrelated settlements', async () => {
  const f = domainLifecycleFixture(cleanups)
  const insert = f.db.prepare(`INSERT INTO journal_settlements VALUES('chat','epoch',?)`)
  for (let index = 0; index < 4096; index++) {
    insert.run(`receipt-${index}`)
  }
  await f.run({
    kind: 'lifecycle',
    input: { settlementId: 'new', fence: 1, mutations: [status('new')] }
  })
  await f.run({
    kind: 'lifecycle',
    input: { settlementId: 'receipt-0', fence: 1, mutations: [status('duplicate')] }
  })
  expect(f.item('orca:duplicate')).toBeUndefined()
  expect(f.item('orca:new')?.body).toEqual({ kind: 'status', text: 'new' })
})

it('returns direct personal input on start failure and lets an earlier handover win', async () => {
  const f = domainLifecycleFixture(cleanups)
  const failure = agentSessionFailureWords({ kind: 'notSignedIn' }, { surface: 'rejection' })
  for (const id of ['queued', 'handed']) {
    await f.run({
      kind: 'submission',
      input: {
        clientMessageId: id,
        body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: id }] },
        fence: 1,
        payloadFingerprint: id,
        handoverRecorded: true,
        source: { kind: 'user' },
        origin: 'client'
      }
    })
  }
  await f.run({
    kind: 'dispatch',
    input: { clientMessageId: 'handed', fence: 1, state: 'pending', turnScope: { kind: 'thread' } }
  })
  await f.run({
    kind: 'start-failure-settle',
    input: { startKey: 'ignored', clientMessageId: 'handed', fence: 1, ...failure }
  })
  const settled = await f.run({
    kind: 'start-failure-settle',
    input: { startKey: 'failed', clientMessageId: 'queued', fence: 1, ...failure }
  })
  expect(
    journalDomainQueueRow(f.db, { sessionId: 'chat', epoch: 'epoch' }, 'queued')?.card
  ).toMatchObject({ state: 'returned', body: { blocks: [{ type: 'text', text: 'queued' }] } })
  expect(
    settled.publication?.items.some(
      (item) => item.body.kind === 'status' && item.body.failure?.kind === 'notSignedIn'
    )
  ).toBe(true)
  expect(f.item('orca:ignored')).toBeUndefined()
})

it('normalizes direct and lifecycle turn ends from the current Stop plus its matching transient overlay', async () => {
  const f = domainLifecycleFixture(cleanups)
  await f.run({
    kind: 'item',
    identity: identity('turn'),
    body: { kind: 'turn', turnId: 't', state: 'running' },
    options
  })
  f.db
    .prepare(`UPDATE journal_chat_state SET queue_latest_stop_json=?`)
    .run(JSON.stringify({ sequence: 1, event: { reason: 'user-stop', at: 50 } }))
  const facts = { ...lifecycleFacts, stopSettle: { sequence: 1, settle: { settling: true } } }
  await f.run(
    {
      kind: 'lifecycle',
      input: {
        settlementId: 'stop',
        fence: 1,
        mutations: [
          {
            kind: 'item',
            identity: identity('turn'),
            body: { kind: 'turn', turnId: 't', state: 'interrupted', completedAt: 70 },
            turnScope: { kind: 'thread' }
          }
        ]
      }
    },
    facts
  )
  expect(f.item('orca:turn')?.body).toMatchObject({ state: 'interrupted', outcome: 'cancellation' })
  await f.run(
    {
      kind: 'item',
      identity: identity('new'),
      body: { kind: 'turn', turnId: 'new', state: 'interrupted', completedAt: 70 },
      options
    },
    { ...facts, stopSettle: { sequence: 0, settle: { settling: true } } }
  )
  expect(f.item('orca:new')?.body).not.toHaveProperty('outcome')
  const output = {
    head: 'x'.repeat(300000),
    byteLength: 300000,
    digest: 'saved-digest',
    truncated: false
  }
  await f.run({
    kind: 'item',
    identity: identity('tool'),
    body: { kind: 'tool-call', name: 'read', input: {}, state: 'running', output },
    options
  })
  expect(f.item('orca:tool')?.body).toMatchObject({
    output: { head: 'x'.repeat(16384), byteLength: 300000, digest: 'saved-digest', truncated: true }
  })
})
