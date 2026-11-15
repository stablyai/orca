import { afterEach, expect, it } from 'vitest'
import {
  domainLifecycleFixture,
  lifecycleIdentity as identity,
  lifecycleOptions as options,
  lifecycleTarget as target
} from './journal-domain-lifecycle.test-fixture'
import { observeJournalDomainInputStop } from './journal-domain-input-ends'
import { readJournalDomainSubmissionAttempt } from './journal-domain-submission-records'

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) {
    cleanup()
  }
})

it('retains an admitted turn identity across removal so a later scoped Stop ends the handover', async () => {
  const f = domainLifecycleFixture(cleanups)
  await f.run({
    kind: 'item',
    identity: identity('turn'),
    body: { kind: 'turn', turnId: 'provider-turn', state: 'running' },
    options
  })
  await f.run({
    kind: 'submission',
    input: {
      clientMessageId: 'send',
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'Continue' }] },
      payloadFingerprint: 'fingerprint',
      fence: 1,
      handoverRecorded: true
    }
  })
  await f.run({
    kind: 'dispatch',
    input: {
      clientMessageId: 'send',
      fence: 1,
      state: 'pending',
      turnScope: { kind: 'turn', turnItemId: 'orca:turn' }
    }
  })
  await f.run({ kind: 'tombstone', identity: identity('turn'), fence: 1 })
  expect(f.item('orca:turn')).toBeUndefined()
  expect(readJournalDomainSubmissionAttempt(f.db, target, 'send')?.ended).toBe(false)
  f.db.exec('BEGIN IMMEDIATE')
  observeJournalDomainInputStop(f.db, target, 'stop', 5, 1, {
    reason: 'user-stop',
    turnId: 'provider-turn',
    at: 100
  })
  f.db.exec('COMMIT')
  f.reopen()
  expect(readJournalDomainSubmissionAttempt(f.db, target, 'send')?.ended).toBe(true)
})

it('observes only the turn body admitted by the complete lifecycle row', async () => {
  const f = domainLifecycleFixture(cleanups)
  await f.run({
    kind: 'submission',
    input: {
      clientMessageId: 'send',
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'Continue' }] },
      payloadFingerprint: 'fingerprint',
      fence: 1,
      handoverRecorded: true
    }
  })
  await f.run({
    kind: 'dispatch',
    input: {
      clientMessageId: 'send',
      fence: 1,
      state: 'pending',
      turnScope: { kind: 'turn', turnItemId: 'orca:turn' }
    }
  })
  await f.run({
    kind: 'lifecycle',
    input: {
      settlementId: 'revised',
      fence: 1,
      mutations: [
        {
          kind: 'item',
          identity: identity('turn'),
          body: { kind: 'turn', turnId: 't', state: 'interrupted' },
          turnScope: { kind: 'thread' }
        },
        {
          kind: 'item',
          identity: identity('turn'),
          body: { kind: 'turn', turnId: 't', state: 'running' },
          turnScope: { kind: 'thread' }
        }
      ]
    }
  })
  expect(readJournalDomainSubmissionAttempt(f.db, target, 'send')?.ended).toBe(false)
  await f.run({
    kind: 'lifecycle',
    input: {
      settlementId: 'removed',
      fence: 1,
      mutations: [
        {
          kind: 'item',
          identity: identity('turn'),
          body: { kind: 'turn', turnId: 't', state: 'interrupted' },
          turnScope: { kind: 'thread' }
        },
        { kind: 'tombstone', identity: identity('turn') }
      ]
    }
  })
  expect(readJournalDomainSubmissionAttempt(f.db, target, 'send')?.ended).toBe(false)
  await f.run({
    kind: 'item',
    identity: identity('turn'),
    body: { kind: 'turn', turnId: 't', state: 'interrupted' },
    options
  })
  expect(readJournalDomainSubmissionAttempt(f.db, target, 'send')?.ended).toBe(true)
})

it('keeps accepted handover and receipt positions after the optimistic item is removed', async () => {
  const f = domainLifecycleFixture(cleanups)
  await f.run({
    kind: 'submission',
    input: {
      clientMessageId: 'send',
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'Hello' }] },
      payloadFingerprint: 'fingerprint',
      fence: 1,
      handoverRecorded: true
    }
  })
  await f.run({
    kind: 'dispatch',
    input: {
      clientMessageId: 'send',
      fence: 1,
      state: 'accepted',
      providerIdentity: identity('provider')
    }
  })
  await f.run({ kind: 'tombstone', identity: identity('send'), fence: 1 })
  expect(f.item('orca:send')).toBeUndefined()
  expect(f.db.prepare(`SELECT accepted_handover_sequence FROM journal_chat_state`).get()).toEqual({
    accepted_handover_sequence: 1
  })
  expect(f.db.prepare(`SELECT cursor_sequence FROM journal_send_receipts`).get()).toEqual({
    cursor_sequence: 2
  })
  await f.run({
    kind: 'submission',
    input: {
      clientMessageId: 'without-provider',
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'Continue' }] },
      payloadFingerprint: 'next-fingerprint',
      fence: 1,
      handoverRecorded: true
    }
  })
  await f.run({
    kind: 'dispatch',
    input: {
      clientMessageId: 'without-provider',
      fence: 1,
      state: 'accepted',
      providerIdentity: null
    }
  })
  expect(f.db.prepare(`SELECT accepted_handover_sequence FROM journal_chat_state`).get()).toEqual({
    accepted_handover_sequence: 4
  })
})
