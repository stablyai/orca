import { afterEach, expect, it } from 'vitest'
import {
  domainLifecycleFixture,
  lifecycleIdentity as identity,
  lifecycleOptions as options,
  lifecycleTarget as target
} from './journal-domain-lifecycle.test-fixture'
import { journalDomainTimelineReads } from './journal-domain-timeline-reads'

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) {
    cleanup()
  }
})

it('refines only proven effective owners and settles reasoning without broadening timeline policy', async () => {
  const f = domainLifecycleFixture(cleanups)
  for (const id of ['matching', 'other']) {
    await f.run({
      kind: 'item',
      identity: identity(id),
      body: {
        kind: 'tool-call',
        name: 'read',
        input: {},
        state: 'failed',
        endedAs: 'unverifiable'
      },
      options
    })
  }
  f.db.prepare(`UPDATE journal_items SET execution_owner=2 WHERE item_id='orca:other'`).run()
  await f.run({
    kind: 'item',
    identity: identity('legacy'),
    body: {
      kind: 'status',
      text: 'turn',
      turnLifecycle: { turnId: 'legacy', state: 'unverifiable' }
    },
    options
  })
  await f.run({
    kind: 'item',
    identity: identity('reasoning'),
    body: {
      kind: 'message',
      role: 'reasoning',
      state: 'running',
      blocks: [{ type: 'text', text: 'thinking' }]
    },
    options
  })
  expect([...journalDomainTimelineReads(f.db, target).unsettled(null)]).toEqual([])
  await f.run({
    kind: 'stale-settle',
    input: {
      sessionId: 'chat',
      fence: 1,
      acquisitionGeneration: 'recovered',
      deathEvidence: { kind: 'exit-observed', ownerFence: 1, observedAt: 150, detail: '' }
    }
  })
  expect(f.item('orca:matching')?.body).toMatchObject({ state: 'failed', endedAs: 'interrupted' })
  expect(f.item('orca:other')?.body).toMatchObject({ state: 'failed', endedAs: 'unverifiable' })
  expect(f.item('orca:legacy')?.body).toMatchObject({
    kind: 'turn',
    state: 'interrupted',
    completedAt: 150
  })
  expect(f.item('orca:reasoning')?.body).toMatchObject({ state: 'completed' })
})

it('inherits the named settled parent outcome instead of inventing an unverified tool ending', async () => {
  const f = domainLifecycleFixture(cleanups)
  await f.run({
    kind: 'item',
    identity: identity('parent'),
    body: { kind: 'turn', turnId: 'parent', state: 'interrupted', completedAt: 75 },
    options
  })
  await f.run({
    kind: 'item',
    identity: identity('tool'),
    body: { kind: 'tool-call', name: 'read', input: {}, state: 'running' },
    options: { ...options, turnScope: { kind: 'turn', turnItemId: 'orca:parent' } }
  })
  await f.run({
    kind: 'stale-settle',
    input: { sessionId: 'chat', fence: 1, acquisitionGeneration: 'parent', deathEvidence: null }
  })
  expect(f.item('orca:tool')?.body).toMatchObject({ state: 'failed', endedAs: 'interrupted' })
})

it('scopes a pending-send-only exit notice to the eligible root already interrupted at that exact time', async () => {
  const f = domainLifecycleFixture(cleanups)
  await f.run({
    kind: 'item',
    identity: identity('root'),
    body: { kind: 'turn', turnId: 'root', state: 'interrupted', completedAt: 150 },
    options
  })
  await f.run({
    kind: 'item',
    identity: identity('older-owner'),
    body: { kind: 'turn', turnId: 'older-owner', state: 'interrupted', completedAt: 150 },
    options
  })
  f.db.prepare(`UPDATE journal_items SET execution_owner=0 WHERE item_id='orca:older-owner'`).run()
  await f.run({
    kind: 'submission',
    input: {
      clientMessageId: 'send',
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'pending' }] },
      fence: 1,
      payloadFingerprint: 'send',
      handoverRecorded: true,
      source: { kind: 'user' },
      origin: 'client'
    }
  })
  await f.run({
    kind: 'dispatch',
    input: { clientMessageId: 'send', fence: 1, state: 'pending', turnScope: { kind: 'thread' } }
  })
  await f.run({
    kind: 'dead-generation-settle',
    input: {
      sessionId: 'chat',
      fence: 1,
      deathEvidence: null,
      below: 1,
      continuingInputs: [],
      finalizingInputs: [],
      exit: {
        ownerFence: 1,
        settlementId: 'exit',
        verdict: { state: 'interrupted', completedAt: 150 },
        pendingSubmissionReason: 'ended'
      }
    }
  })
  expect(f.item('orca:exit')).toMatchObject({
    turnScope: { kind: 'turn', turnItemId: 'orca:root' }
  })
})

it('updates legacy context presence with visibility, replacement and removal and seeks absent eligible subsets', async () => {
  const f = domainLifecycleFixture(cleanups)
  const view = journalDomainTimelineReads(f.db, target)
  await f.run({
    kind: 'item',
    identity: identity('window'),
    body: {
      kind: 'status',
      text: 'legacy',
      turnLifecycle: {
        turnId: 'window',
        state: 'completed',
        contextUsage: { window: { tokens: 0, capturedAt: 0 } }
      }
    },
    options
  })
  expect(view.contextWindowHeld()).toBe(true)
  f.db.prepare(`UPDATE journal_items SET hidden=1 WHERE item_id='orca:window'`).run()
  expect(view.contextWindowHeld()).toBe(false)
  f.db.prepare(`UPDATE journal_items SET hidden=0 WHERE item_id='orca:window'`).run()
  await f.run({ kind: 'epoch-replace', reason: 'legacy_import', fence: 1, items: [] })
  expect(view.contextWindowHeld()).toBe(false)
  await f.run({
    kind: 'item',
    identity: identity('window'),
    body: {
      kind: 'turn',
      turnId: 'window',
      state: 'completed',
      contextUsage: { window: { tokens: 100, capturedAt: 100 } }
    },
    options
  })
  await f.run({ kind: 'tombstone', identity: identity('window'), fence: 1 })
  expect(view.contextWindowHeld()).toBe(false)
  for (const [predicate, index] of [
    [`hidden=0 AND context_window=1`, 'journal_items_context_window'],
    [
      `hidden=0 AND (lifecycle_state IN ('running','pending') OR live_work=1)`,
      'journal_items_unsettled'
    ],
    [
      `hidden=0 AND kind IN ('turn','status') AND lifecycle_state='unverifiable'`,
      'journal_items_unverifiable_turn'
    ],
    [`hidden=0 AND unverified_end=1`, 'journal_items_unverified_end'],
    [
      `hidden=0 AND root=1 AND kind IN ('turn','status') AND lifecycle_state='interrupted' AND turn_completed_at IS NOT NULL AND turn_completed_at=150`,
      'journal_items_interrupted_root'
    ]
  ]) {
    const plan = f.db
      .prepare(
        `EXPLAIN QUERY PLAN SELECT 1 FROM journal_items INDEXED BY ${index} WHERE session_id=? AND epoch=? AND ${predicate} LIMIT 1`
      )
      .all('chat', 'epoch')
    expect(plan.map((row) => row.detail).join('\n')).toContain(index)
  }
})

it('uses the visible named opener to preserve historical replay instead of settling it as live work', async () => {
  const f = domainLifecycleFixture(cleanups)
  const turn = {
    provider: 'legacy' as const,
    agent: 'grok',
    sessionId: 'thread',
    recordId: 'turn-lifecycle:p:hist:t'
  }
  const opener = {
    provider: 'legacy' as const,
    agent: 'grok',
    sessionId: 'thread',
    recordId: 'item:p:hist:hist/user%3A1'
  }
  const turnKey = 'legacy:grok:thread:turn-lifecycle%3Ap%3Ahist%3At'
  const openerKey = 'legacy:grok:thread:item%3Ap%3Ahist%3Ahist%2Fuser%253A1'
  await f.run({
    kind: 'item',
    identity: opener,
    body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'historical' }] },
    options: { ...options, turnScope: { kind: 'turn', turnItemId: turnKey } }
  })
  await f.run({
    kind: 'item',
    identity: turn,
    body: { kind: 'turn', turnId: 'p:hist:t', userItemId: openerKey, state: 'running' },
    options
  })
  await f.run({
    kind: 'item',
    identity: identity('historical-tool'),
    body: { kind: 'tool-call', name: 'read', input: {}, state: 'running' },
    options: { ...options, turnScope: { kind: 'turn', turnItemId: turnKey } }
  })
  await f.run({
    kind: 'stale-settle',
    input: {
      sessionId: 'chat',
      fence: 1,
      acquisitionGeneration: 'historical',
      deathEvidence: { kind: 'exit-observed', ownerFence: 1, observedAt: 150, detail: '' }
    }
  })
  expect(f.item(turnKey)?.body).toMatchObject({ state: 'running' })
  expect(f.item('orca:historical-tool')?.body).toMatchObject({ state: 'running' })
  await f.run({ kind: 'tombstone', identity: opener, fence: 1 })
  await f.run({
    kind: 'stale-settle',
    input: {
      sessionId: 'chat',
      fence: 1,
      acquisitionGeneration: 'no-opener',
      deathEvidence: { kind: 'exit-observed', ownerFence: 1, observedAt: 150, detail: '' }
    }
  })
  expect(f.item(turnKey)?.body).toMatchObject({ state: 'interrupted' })
  expect(f.item('orca:historical-tool')?.body).toMatchObject({
    state: 'failed',
    endedAs: 'interrupted'
  })
})

it('settles dead and older sends while retaining a continuing handover', async () => {
  const f = domainLifecycleFixture(cleanups)
  for (const [id, fence] of [
    ['old', 1],
    ['exited', 2],
    ['continuing', 2]
  ] as const) {
    await f.run({
      kind: 'submission',
      input: {
        clientMessageId: id,
        payloadFingerprint: id,
        body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: id }] },
        fence
      }
    })
  }
  await f.run({
    kind: 'dead-generation-settle',
    input: {
      sessionId: 'chat',
      fence: 3,
      below: 2,
      deathEvidence: null,
      exit: {
        ownerFence: 2,
        settlementId: 'exit',
        verdict: { state: 'interrupted', completedAt: 800 },
        pendingSubmissionReason: 'provider_exited',
        showUnexpectedExitOutcome: false
      },
      continuingInputs: ['continuing'],
      finalizingInputs: []
    }
  })
  const entries = f.db
    .prepare(
      'SELECT message_id,dispatch_state FROM journal_submission_attempts WHERE current=1 ORDER BY ordinal'
    )
    .all()
  expect(entries).toEqual([
    { message_id: 'old', dispatch_state: 'unknown' },
    { message_id: 'exited', dispatch_state: 'unknown' },
    { message_id: 'continuing', dispatch_state: 'pending' }
  ])
})

it('keeps a continuing send pending and avoids an exit notice for an owned finalizer', async () => {
  const f = domainLifecycleFixture(cleanups)
  for (const id of ['continuing', 'own-finalizer']) {
    await f.run({
      kind: 'submission',
      input: {
        clientMessageId: id,
        payloadFingerprint: id,
        body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: id }] },
        fence: 1
      }
    })
  }
  const settled = await f.run({
    kind: 'dead-generation-settle',
    input: {
      sessionId: 'chat',
      fence: 2,
      below: 1,
      deathEvidence: null,
      exit: {
        ownerFence: 1,
        settlementId: 'exit',
        verdict: { state: 'unverifiable' },
        pendingSubmissionReason: 'provider_exited'
      },
      continuingInputs: ['continuing'],
      finalizingInputs: [{ clientMessageId: 'own-finalizer', settlementOwner: true }]
    }
  })
  expect(
    f.db
      .prepare(
        'SELECT message_id,dispatch_state FROM journal_submission_attempts WHERE current=1 ORDER BY ordinal'
      )
      .all()
  ).toEqual([
    { message_id: 'continuing', dispatch_state: 'pending' },
    { message_id: 'own-finalizer', dispatch_state: 'unknown' }
  ])
  expect(settled.publication?.items).toEqual([])
})
