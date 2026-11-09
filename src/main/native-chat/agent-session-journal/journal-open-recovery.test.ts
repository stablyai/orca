import { afterEach, expect, it } from 'vitest'
import { domainLifecycleFixture } from './journal-domain-lifecycle.test-fixture'
import { automaticBody } from './journal-automatic-submission.test-fixture'
import { journalDomainSubmission } from './journal-domain-status-inputs'
import { journalDomainQueueRow } from './journal-domain-queue-rows'
import { JournalSqlScope } from './journal-sql-scope'
import { nextJournalDomainQueueCard } from './journal-domain-submission-consume'

const cleanups: (() => void)[] = []
afterEach(() => cleanups.splice(0).forEach((cleanup) => cleanup()))

async function fixture() {
  const f = domainLifecycleFixture(cleanups)
  await f.run({
    kind: 'submission',
    input: {
      clientMessageId: 'handed',
      body: automaticBody('already handed over'),
      payloadFingerprint: 'handed',
      fence: 1,
      origin: 'host'
    }
  })
  await f.run({
    kind: 'submission',
    input: {
      clientMessageId: 'unsent',
      body: automaticBody('keep my text'),
      payloadFingerprint: 'unsent',
      fence: 1,
      handoverRecorded: true,
      origin: 'host',
      source: { kind: 'user' }
    }
  })
  const scope = new JournalSqlScope(f.db, 'chat', 'epoch')
  return { ...f, scope }
}

it('opens at its original boundary, recovers sends and holds the recovered personal card before readers', async () => {
  const f = await fixture()
  const opened = await f.run({ kind: 'open', recover: { fence: 1 } })
  expect(opened.value).toEqual({ epoch: 'epoch', sequence: 2 })
  expect(opened.openRecovery).toEqual({ failures: [], reopenFloor: null })
  expect(journalDomainSubmission(f.scope, 'handed')).toMatchObject({
    dispatchState: 'unknown',
    recovered: true
  })
  expect(journalDomainSubmission(f.scope, 'unsent')).toMatchObject({
    dispatchState: 'rejected',
    keptAsQueuedMessageId: 'unsent'
  })
  expect(journalDomainQueueRow(f.db, f.scope, 'unsent')?.card).toMatchObject({
    state: 'waiting',
    body: { blocks: [{ type: 'text', text: 'keep my text' }] }
  })
  expect(
    nextJournalDomainQueueCard(f.db, f.scope, {
      reopenFloor: null,
      now: 100,
      automatic: true,
      steer: false
    })
  ).toEqual({ kind: 'selected', card: null })
})

it('retains earlier recovery and a conservative reopen floor when the final mark fails', async () => {
  const f = await fixture()
  f.db
    .exec(`CREATE TRIGGER reject_open_mark BEFORE UPDATE OF queue_reopened_sequence ON journal_chat_state
    WHEN NEW.queue_reopened_sequence<>OLD.queue_reopened_sequence
    BEGIN SELECT RAISE(ABORT,'mark unavailable'); END`)
  const opened = await f.run({ kind: 'open', recover: { fence: 1 } })
  expect(opened.openRecovery?.failures).toMatchObject([
    { step: 'queue-reopen', failure: { message: 'mark unavailable' } }
  ])
  expect(journalDomainSubmission(f.scope, 'handed')?.dispatchState).toBe('unknown')
  expect(journalDomainQueueRow(f.db, f.scope, 'unsent')?.card.state).toBe('waiting')
  const reopenFloor = opened.openRecovery!.reopenFloor
  expect(reopenFloor).not.toBeNull()
  expect(
    nextJournalDomainQueueCard(f.db, f.scope, {
      reopenFloor,
      now: 100,
      automatic: true,
      steer: false
    })
  ).toEqual({ kind: 'selected', card: null })
})
