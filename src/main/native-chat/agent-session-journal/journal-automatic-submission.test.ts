import { afterEach, expect, it } from 'vitest'
import {
  automaticSubmissionFixture,
  automaticBody,
  automaticMail
} from './journal-automatic-submission.test-fixture'
import { commandReceiptFixture } from './writing/command-receipt-test-support'

const cleanups: (() => void)[] = []
afterEach(() => cleanups.splice(0).forEach((cleanup) => cleanup()))

it('claims owed mail with the selected stored body and sparse options, without saving compiler defaults', async () => {
  const f = automaticSubmissionFixture(cleanups)
  await f.enqueue('mail', {
    body: { ...automaticBody('notice'), from: automaticMail },
    options: {}
  })
  expect((await f.claim('needs', f.prepare())).value).toEqual({
    kind: 'needs-custody',
    source: automaticMail
  })
  expect(f.card('mail')?.state).toBe('waiting')
  const preparation = f.prepare(100, 'owed')
  expect((await f.claim('send', preparation)).value).toEqual({
    kind: 'claimed',
    messageId: 'mail',
    clientMessageId: 'send'
  })
  expect(f.attempt('send')).toMatchObject({
    admittedPersonal: false,
    admission: {
      familyId: 'mail',
      options: {},
      body: { blocks: [{ type: 'text', text: 'notice' }], from: automaticMail }
    },
    submission: { origin: 'host', queuedMessageId: 'mail' }
  })
  expect(f.card('mail')).toMatchObject({ state: 'dispatched', consumedAs: 'send' })
})

it('evaluates the first nonmail fallback itself and waits on it instead of bypassing it', async () => {
  const f = automaticSubmissionFixture(cleanups)
  await f.turn()
  await f.enqueue('mail', {
    body: { ...automaticBody('notice'), from: automaticMail },
    options: { model: 'active' }
  })
  await f.enqueue('later-mail', {
    body: {
      ...automaticBody('later'),
      from: {
        ...automaticMail,
        orchestration: { ...automaticMail.orchestration, mailbox: 'later' }
      }
    }
  })
  await f.enqueue('person', { options: { model: 'different' } })
  await f.enqueue('later-person', { options: { model: 'active' } })
  expect((await f.claim('waiting', f.prepare(100, 'unavailable'))).value).toEqual({
    kind: 'waiting'
  })
  expect(f.attempt('waiting')).toBeNull()
  expect(f.card('person')?.state).toBe('waiting')
  f.selection.steering = {
    kind: 'codex',
    compiler: {
      active: { model: 'different' },
      activeInput: { model: 'different' },
      defaults: {},
      models: [],
      listedServiceTiers: []
    }
  }
  expect((await f.claim('send', f.prepare(100, 'unavailable'))).value).toEqual({
    kind: 'claimed',
    messageId: 'person',
    clientMessageId: 'send'
  })
  expect(f.card('mail')?.state).toBe('waiting')
  expect(f.card('later-mail')?.state).toBe('waiting')
  expect(f.card('later-person')?.state).toBe('waiting')
  expect(f.attempt('send')).toMatchObject({
    admittedPersonal: true,
    admission: { options: { model: 'different' } }
  })
})

it('asks only for the sender reached at its writer position and withdraws stale mail without a submission', async () => {
  const f = automaticSubmissionFixture(cleanups)
  await f.enqueue('mail', { body: { ...automaticBody('notice'), from: automaticMail } })
  const before = f.prepare(100, 'owed')
  await f.enqueue('earlier', {
    body: {
      ...automaticBody('earlier'),
      from: {
        ...automaticMail,
        orchestration: { ...automaticMail.orchestration, mailbox: 'earlier' }
      }
    }
  })
  await f.run({ kind: 'queue-move', input: { messageId: 'earlier', beforeMessageId: 'mail' } })
  const earlier = {
    ...automaticMail,
    orchestration: { ...automaticMail.orchestration, mailbox: 'earlier' }
  }
  expect((await f.claim('changed', before)).value).toEqual({
    kind: 'needs-custody',
    source: earlier
  })
  expect(f.card('mail')?.state).toBe('waiting')
  expect(f.attempt('changed')).toBeNull()
  expect(
    (await f.claim('stale', { ...f.prepare(), mail: [[JSON.stringify(earlier), 'stale']] })).value
  ).toEqual({
    kind: 'withdrawn',
    messageId: 'earlier'
  })
  expect(f.card('earlier')?.state).toBe('withdrawn')
  expect(f.attempt('stale')).toBeNull()
})

it('keeps overlapping edit barriers at the fixed preparation instant and returns their deadline', async () => {
  const f = automaticSubmissionFixture(cleanups)
  await f.enqueue('mail', { body: { ...automaticBody('notice'), from: automaticMail } })
  await f.enqueue('person')
  for (const callerKey of ['desktop', 'phone']) {
    await f.run({
      kind: 'edit-lease',
      operation: {
        kind: 'acquire',
        callerKey,
        editId: callerKey,
        messageId: 'person',
        fingerprint: f.card('person')!.fingerprint
      }
    })
  }
  await f.run({
    kind: 'edit-lease',
    operation: { kind: 'release', callerKey: 'desktop', editId: 'desktop', messageId: 'person' }
  })
  const prepared = f.prepare(100, 'unavailable')
  const blocked = await f.claim('blocked', prepared, undefined, 130_000)
  expect(blocked.value).toEqual({ kind: 'waiting' })
  expect(blocked.publication?.editDeadline).toBe(120_100)
  expect(f.card('person')?.state).toBe('waiting')
  expect(
    (await f.claim('send', f.prepare(130_000, 'unavailable'), undefined, 130_000)).value
  ).toEqual({ kind: 'claimed', messageId: 'person', clientMessageId: 'send' })
})

it('requires a ready accepting child only while steering and rolls failed conversion back before holding its actual card', async () => {
  const f = automaticSubmissionFixture(cleanups)
  await f.turn('compact:command')
  await f.enqueue('person', { options: {} })
  expect((await f.claim('command', f.prepare())).value).toEqual({ kind: 'waiting' })
  await f.turn()
  f.selection.child!.ready = false
  expect((await f.claim('not-ready', f.prepare())).value).toEqual({ kind: 'waiting' })
  await f.run({
    kind: 'item',
    identity: { provider: 'orca', clientMessageId: 'turn' },
    body: { kind: 'turn', turnId: 'running', state: 'completed' },
    options: { fence: 1, turnScope: { kind: 'thread' } }
  })
  f.selection.child = null
  const failed = await f.claim('failed', f.prepare(), [
    {
      kind: 'receipt',
      scope: { kind: 'global' },
      receipt: commandReceiptFixture({ sessionId: 'chat-test' }),
      row: { at: 'last', kinds: ['tombstone'], answer: 'journal-row' }
    }
  ])
  expect(failed.value).toMatchObject({ kind: 'failed', messageId: 'person' })
  expect(f.attempt('failed')).toBeNull()
  expect(f.item('orca:failed')).toBeUndefined()
  expect(f.card('person')).toMatchObject({
    state: 'waiting',
    consumedAs: null,
    holdReason: 'send_failed'
  })
})
