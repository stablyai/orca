import { afterEach, expect, it } from 'vitest'
import { sqlRewindFixture, rewindMessage } from './journal-sql-provider-rewind.test-fixture'
import { planJournalDomainRewindCut } from './journal-domain-rewind-cut'
import { JournalSqlScope } from './journal-sql-scope'

const cleanups: (() => void)[] = []
afterEach(() => cleanups.splice(0).forEach((close) => close()))
const host = (clientMessageId: string) => ({ provider: 'orca' as const, clientMessageId })
const turn = (recordId: string) => ({
  provider: 'legacy' as const,
  agent: 'trae' as const,
  sessionId: 'chat-rewind',
  recordId
})

it('rewinds a Trae opener while keeping late output on the preceding turn and pending input', async () => {
  const f = sqlRewindFixture(cleanups)
  const old = 'legacy:trae:chat-rewind:turn-lifecycle%3Ap%3Athread%3Aold%252Fturn'
  const next = 'legacy:trae:chat-rewind:turn-lifecycle%3Ap%3Athread%3Anext%252Fturn'
  await f.write(host('first'), rewindMessage('first', 'user'))
  await f.write(turn('turn-lifecycle:p:thread:old%2Fturn'), {
    kind: 'turn',
    turnId: 'p:thread:old%2Fturn',
    providerTurnId: 'old/turn',
    userItemId: 'orca:first',
    state: 'completed'
  })
  await f.write(host('target'), rewindMessage('target', 'user'))
  await f.write(turn('turn-lifecycle:p:thread:next%2Fturn'), {
    kind: 'turn',
    turnId: 'p:thread:next%2Fturn',
    providerTurnId: 'next/turn',
    userItemId: 'orca:target',
    state: 'completed'
  })
  await f.write(host('late'), rewindMessage('late child output'), {
    turnScope: { kind: 'turn', turnItemId: old },
    agentId: 'child',
    producerKind: 'agent'
  })
  await f.run({
    kind: 'submission',
    input: {
      clientMessageId: 'queued',
      body: rewindMessage('queued', 'user'),
      payloadFingerprint: 'queued',
      fence: 1,
      handoverRecorded: true,
      origin: 'client',
      source: { kind: 'user' }
    }
  })
  const scope = new JournalSqlScope(f.db, 'chat-rewind', 'epoch')
  expect(
    planJournalDomainRewindCut(scope, {
      itemId: 'orca:target',
      provider: 'trae',
      nativeId: 'thread'
    })?.cut
  ).toMatchObject({ beforeTurnId: 'next/turn', keptTurnId: 'old/turn' })
  expect(
    planJournalDomainRewindCut(scope, {
      itemId: 'orca:target',
      provider: 'trae',
      nativeId: 'other'
    })
  ).toBeNull()
  await f.prepare('orca:target').complete()
  expect(f.item('orca:first')?.body).toMatchObject({ blocks: [{ type: 'text', text: 'first' }] })
  expect(f.item(old)?.body).toMatchObject({ state: 'completed' })
  expect(f.item('orca:late')?.body).toMatchObject({
    blocks: [{ type: 'text', text: 'late child output' }]
  })
  expect(f.item('orca:queued')?.body).toMatchObject({ blocks: [{ type: 'text', text: 'queued' }] })
  expect(f.item('orca:target')).toBeUndefined()
  expect(f.item(next)).toBeUndefined()
})
