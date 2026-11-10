import { expect, it } from 'vitest'
import { agentSessionFailureFact } from '../../../shared/agent-session/failures/agent-session-failure'
import { agentSessionFailureWords } from '../../../shared/agent-session/failures/agent-session-failure-words'
import type { JournalInputRead, JournalInputReadResult } from './journal-input-reads'
import { createFixture } from './queued-messages/journal-unsent-send-hold-contract-test-fixture'

const fixture = createFixture()

const READS: JournalInputRead[] = [
  { kind: 'recoverable-submissions' },
  { kind: 'pending-submissions' },
  { kind: 'accepted-submissions' },
  { kind: 'unsettled-submissions' },
  { kind: 'capture-keys', present: ['rendered-only', 'orca:accepted'] },
  { kind: 'recovered-unknown-ids' },
  { kind: 'linked-to', messageId: 'card' },
  { kind: 'input-ordinal', clientMessageId: 'missing' },
  { kind: 'input-count' },
  { kind: 'signed-out-at', fence: 0 },
  { kind: 'signed-out-at', fence: 7 }
]

function ids(result: JournalInputReadResult): string[] {
  return 'submissions' in result ? result.submissions.map((entry) => entry.clientMessageId) : []
}

it('keeps recovery, acceptance, linkage and sign-out evidence available after reopen', async () => {
  const journal = await fixture.open()
  for (const id of ['accepted', 'pending', 'signed-out', 'unknown']) {
    await fixture.accept(journal, id)
  }
  await journal.resolveDispatch({
    clientMessageId: 'accepted',
    fence: 0,
    state: 'accepted',
    providerIdentity: { provider: 'claude', sessionId: 'native-1', uuid: 'accepted-echo' }
  })
  await journal.resolveDispatch({
    clientMessageId: 'signed-out',
    fence: 0,
    state: 'rejected',
    ...agentSessionFailureWords(agentSessionFailureFact('notSignedIn'), { surface: 'rejection' })
  })
  await journal.resolveDispatch({
    clientMessageId: 'unknown',
    fence: 0,
    state: 'unknown',
    recovered: true
  })
  await journal.queuedMessages.insert({ messageId: 'card', body: fixture.message('linked') })
  await journal.appendSubmission(
    {
      clientMessageId: 'linked',
      payloadFingerprint: (await journal.queuedMessages.get('card'))!.fingerprint,
      body: fixture.message('linked'),
      fence: 0,
      handoverRecorded: true
    },
    { messageId: 'card', expect: 'waiting' }
  )
  const before = await journal.reads.input({ kind: 'capture-keys', present: [] })
  await journal.appendSubmission({
    clientMessageId: 'legacy:raw/%',
    payloadFingerprint: fixture.fingerprint(fixture.message('legacy')),
    body: fixture.message('legacy'),
    fence: 0
  })
  expect(before.keys).not.toContain('orca:legacy%3Araw%2F%25')
  await journal.close()
  const reopened = await fixture.open()
  const answers = await Promise.all(READS.map((read) => reopened.reads.input(read)))
  const answer = (kind: JournalInputRead['kind']) =>
    answers[READS.findIndex((r) => r.kind === kind)]
  expect(ids(answer('recoverable-submissions'))).toEqual(['legacy:raw/%'])
  expect(ids(answer('pending-submissions'))).toEqual(['legacy:raw/%'])
  expect(ids(answer('accepted-submissions'))).toEqual([
    'accepted',
    'pending',
    'signed-out',
    'unknown',
    'linked'
  ])
  expect(ids(answer('unsettled-submissions'))).toEqual(['unknown', 'legacy:raw/%'])
  expect(answer('capture-keys')).toEqual({
    kind: 'capture-keys',
    keys: [
      'orca:accepted',
      'orca:legacy%3Araw%2F%25',
      'orca:linked',
      'orca:pending',
      'orca:signed-out',
      'orca:unknown',
      'rendered-only'
    ]
  })
  expect(answer('recovered-unknown-ids')).toEqual({
    kind: 'recovered-unknown-ids',
    ids: ['unknown']
  })
  expect(ids(answer('linked-to'))).toEqual(['linked'])
  expect(answers[7]).toEqual({ kind: 'input-ordinal', ordinal: Infinity })
  expect(answer('input-count')).toEqual({ kind: 'input-count', count: 6 })
  expect(answers[9]).toEqual({ kind: 'signed-out-at', answer: true })
  expect(answers[10]).toEqual({ kind: 'signed-out-at', answer: false })
})
