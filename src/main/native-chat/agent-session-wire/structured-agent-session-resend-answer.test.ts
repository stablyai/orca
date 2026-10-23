// What a resend of a send id gets: the answer its record holds, never a refusal made before the
// host looked the id up, and never a made-up record.

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import { openTestJournalHostDatabase } from '../agent-session-journal/journal-host-database-test-support'
import { DISPATCH_DOUBT_SUBMISSION_MISSING } from '../agent-session-journal/journal-dispatch-doubt-reasons'
import { persistRewindRecord } from './structured-rewind-recovery'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import type { StructuredAgentSessionHost } from './structured-agent-session-host'
import {
  attach,
  CALLER,
  envelope,
  hostTestState
} from './structured-agent-session-host-test-harness'
import {
  HOST_TEST_SESSION as SESSION,
  HOST_TEST_NOW as NOW,
  HOST_TEST_THREAD as THREAD,
  hostTestMessage
} from './structured-agent-session-host-test-data'
import { createQueuedMessageTestRig } from './structured-agent-session-queued-message-rig.test-fixture'

let root: string
let store: AgentSessionRecordStore
let host: StructuredAgentSessionHost
let dispatch: Mock<StructuredAgentSessionAdapter['dispatch']>
let acquire: Mock<StructuredAgentSessionAdapter['acquire']>

beforeEach(() => {
  ;({ root, store, host, dispatch, acquire } = hostTestState())
})

afterEach(() => vi.restoreAllMocks())

function hostJournal(): AgentSessionJournal {
  return host.collaboratorsForTests().sessions.get(SESSION)!.journal
}

function sendParams(text: string) {
  const body = hostTestMessage(text)
  return { envelope: envelope('agentSession.send', { body }), body }
}

async function deliveredOnce(): Promise<void> {
  await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1))
}

describe('a resent send id', () => {
  it('re-evaluates a pre-acceptance failure after the chat is reopened', async () => {
    await attach()
    vi.spyOn(hostJournal(), 'appendSubmission').mockRejectedValueOnce(new Error('disk full'))
    const params = sendParams('refused once')
    const first = await host.send(CALLER, params)
    expect(first).toMatchObject({
      ok: false,
      refusal: { code: 'agent_session_operation_invalid' }
    })
    await host.close(SESSION, 'evict')
    expect(host.hasSession(SESSION)).toBe(false)

    const resent = await host.send(CALLER, params)

    expect(resent).toMatchObject({ ok: true, replayed: false })
    expect(host.hasSession(SESSION)).toBe(true)
    await deliveredOnce()
  })

  it('answers unknown, never a refusal, when the chat holding its answer cannot be opened', async () => {
    await attach()
    const params = sendParams('recorded, then the chat would not open')
    await host.send(CALLER, params)
    await deliveredOnce()
    await host.close(SESSION, 'evict')
    const connection = openTestJournalHostDatabase(root).db
    const prepare = connection.prepare.bind(connection)
    vi.spyOn(connection, 'prepare').mockImplementation((sql: string) => {
      if (sql.includes('journal_')) {
        throw Object.assign(new Error('database disk image is malformed'), {
          code: 'ERR_SQLITE_ERROR',
          errcode: 11
        })
      }
      return prepare(sql)
    })
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    await expect(host.send(CALLER, params)).resolves.toMatchObject({
      ok: false,
      refusal: { code: 'agent_session_operation_unknown', details: { reason: 'outcomeUnknown' } }
    })
    // A new id meets the same chat as a first run, and is refused for what it is.
    await expect(host.send(CALLER, sendParams('a new message'))).resolves.toMatchObject({
      ok: false,
      refusal: { code: 'agent_session_journal_unreadable' }
    })
    expect(dispatch).toHaveBeenCalledTimes(1)
  })

  it('is answered from its record while a /clear is in flight; a new id is refused', async () => {
    await attach()
    const params = sendParams('sent before the clear')
    expect(await host.send(CALLER, params)).toMatchObject({ ok: true, replayed: false })

    const clearing = host.conversationCommand(CALLER, {
      command: 'clear',
      envelope: envelope('agentSession.conversationCommand', { command: 'clear' })
    })
    const resent = host.send(CALLER, params)
    const fresh = host.send(CALLER, sendParams('typed during the clear'))
    await clearing

    await expect(resent).resolves.toMatchObject({
      ok: true,
      replayed: true,
      value: { submission: { clientMessageId: params.envelope.clientOperationId } }
    })
    await expect(fresh).resolves.toMatchObject({
      ok: false,
      refusal: { details: { reason: 'conversationCommandInFlight' } }
    })
  })

  it('waits for an original still being accepted and answers with its submission', async () => {
    await attach()
    const journal = hostJournal()
    const append = journal.appendSubmission.bind(journal)
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    vi.spyOn(journal, 'appendSubmission').mockImplementationOnce(async (...args) => {
      await held
      return append(...args)
    })
    const params = sendParams('resent while the first is mid-write')

    const original = host.send(CALLER, params)
    const resent = host.send(CALLER, params)
    await vi.waitFor(() => expect(journal.appendSubmission).toHaveBeenCalledTimes(1))
    release()

    const [first, second] = await Promise.all([original, resent])
    expect(first).toMatchObject({ ok: true, replayed: false })
    expect(second).toMatchObject({
      ok: true,
      replayed: true,
      value: { submission: { clientMessageId: params.envelope.clientOperationId } }
    })
    if (!second.ok || !('submission' in second.value)) {
      throw new Error('expected the submission arm')
    }
    expect(second.value.submission.reason).not.toBe(DISPATCH_DOUBT_SUBMISSION_MISSING)
    await deliveredOnce()
    expect(journal.submissions()).toHaveLength(1)
    expect(
      store
        .listOperationRows()
        .filter((row) => row.operationId === params.envelope.clientOperationId)
    ).toHaveLength(1)
  })

  it('is answered from the chat while a rewind is in doubt, starting no agent', async () => {
    await attach()
    const params = sendParams('sent before the rewind')
    await host.send(CALLER, params)
    await deliveredOnce()
    await host.close(SESSION, 'evict')
    // Only the provider can settle this rewind, so a send's first run would start it.
    await persistRewindRecord(store, SESSION, store.getRecord(SESSION)!.lease.runtimeFence, {
      operationId: 'rewind-op',
      callerKey: CALLER.callerKey,
      itemId: 'orca:rewound',
      providerItemId: `codex:${THREAD}:turn-1:0`,
      expectedEpoch: 'epoch-before',
      phase: 'prepared',
      retained: []
    })
    acquire.mockClear()
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    await expect(host.send(CALLER, params)).resolves.toMatchObject({
      ok: true,
      replayed: true,
      value: { submission: { clientMessageId: params.envelope.clientOperationId } }
    })
    expect(acquire).not.toHaveBeenCalled()
    expect(store.getRecord(SESSION)?.rewind?.phase).toBe('prepared')
  })

  it('answers unknown, never a refusal, from a store a newer Orca wrote, which takes no write', async () => {
    await attach()
    const params = sendParams('sent, then a newer Orca wrote the store')
    await host.send(CALLER, params)
    await deliveredOnce()
    await host.close(SESSION, 'evict')
    const rowsBefore = store.listOperationRows()
    Object.defineProperty(openTestJournalHostDatabase(root), 'readOnly', { value: true })
    expect(store.readOnly).toBe(true)
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    // This build never reads a newer Orca's chat, so the answer its journal holds stays unknown.
    await expect(host.send(CALLER, params)).resolves.toMatchObject({
      ok: false,
      refusal: { code: 'agent_session_operation_unknown', details: { reason: 'outcomeUnknown' } }
    })
    expect(dispatch).toHaveBeenCalledTimes(1)
    expect(store.listOperationRows()).toEqual(rowsBefore)
  })
})

describe('a send queued behind a running turn', () => {
  it('commits its accepted row with its draft, so a failed settlement loses no answer', async () => {
    const rig = await createQueuedMessageTestRig()
    try {
      await rig.workingSend()
      const settle = vi
        .spyOn(rig.store, 'recordOperationOutcome')
        .mockRejectedValue(new Error('operation settlement failed'))
      const queued = rig.send('queued behind the turn', 'queue-if-active')

      await expect(queued.result).resolves.toMatchObject({
        ok: true,
        value: { queued: { messageId: queued.id, state: 'waiting' } }
      })
      expect(
        rig.store.listOperationRows().find((row) => row.operationId === queued.id)
      ).toMatchObject({ outcome: { status: 'succeeded' } })
      expect(settle).not.toHaveBeenCalled()
    } finally {
      await rig.dispose()
    }
  })
})

describe('send receipt acceptance', () => {
  it.each(['body', 'delivery'] as const)(
    'conflicts when the same id changes its %s',
    async (field) => {
      await attach()
      const params = sendParams('original')
      expect(await host.send(CALLER, params)).toMatchObject({ ok: true })
      await deliveredOnce()
      const body = field === 'body' ? hostTestMessage('changed') : params.body
      const fields = {
        body,
        ...(field === 'delivery' ? { delivery: 'queue-if-active' as const } : {})
      }
      await expect(
        host.send(CALLER, {
          ...fields,
          envelope: envelope('agentSession.send', fields, {
            clientOperationId: params.envelope.clientOperationId
          })
        })
      ).resolves.toMatchObject({
        ok: false,
        refusal: {
          code: 'agent_session_operation_conflict',
          details: { reason: 'operationIdReused' }
        }
      })
      expect(dispatch).toHaveBeenCalledTimes(1)
    }
  )

  it('conflicts with an unswitched caller ledger row even after its expiry', async () => {
    await attach()
    const body = hostTestMessage('reuses Stop')
    const old = NOW - 3 * 24 * 60 * 60_000
    const params = {
      envelope: envelope(
        'agentSession.send',
        { body },
        { clientOperationId: `${old}-${'a'.repeat(32)}` }
      ),
      body
    }
    await store.admitOperation({
      callerKey: 'another-caller',
      operationId: params.envelope.clientOperationId,
      fingerprint: envelope('agentSession.cancel', {}).payloadFingerprint,
      now: old
    })
    expect(
      store.listOperationRows().find((row) => row.operationId === params.envelope.clientOperationId)
        ?.expiresAt
    ).toBeLessThan(NOW)
    const before = store.listOperationRows()
    await expect(host.send(CALLER, params)).resolves.toMatchObject({
      ok: false,
      refusal: {
        code: 'agent_session_operation_conflict',
        details: { reason: 'operationIdReused' }
      }
    })
    expect(store.listOperationRows()).toEqual(before)
    expect(hostJournal().submissions()).toHaveLength(0)
    expect(store.readCommandReceipt({ kind: 'global' }, params.envelope.clientOperationId)).toEqual(
      { verdict: 'absent' }
    )
  })

  it('keeps the temporary ledger row so Stop cannot reuse a send id', async () => {
    await attach()
    const params = sendParams('accepted')
    await host.send(CALLER, params)
    await deliveredOnce()
    await expect(
      host.cancel(CALLER, {
        envelope: envelope(
          'agentSession.cancel',
          {},
          { clientOperationId: params.envelope.clientOperationId }
        )
      })
    ).resolves.toMatchObject({
      ok: false,
      refusal: {
        code: 'agent_session_operation_conflict',
        details: { reason: 'operationIdReused' }
      }
    })
  })

  it.each(['agent_session_command_receipts', 'agent_session_operations'])(
    'rolls back the message when %s cannot be written, then retries the same id fresh',
    async (table) => {
      await attach()
      const params = sendParams('receipt must commit')
      const db = openTestJournalHostDatabase(root).db
      db.exec(`CREATE TRIGGER fail_receipt BEFORE INSERT ON ${table}
      BEGIN SELECT RAISE(ABORT, 'receipt storage failed'); END`)
      await expect(host.send(CALLER, params)).resolves.toMatchObject({
        ok: false,
        refusal: { details: { reason: 'journalWriteFailed' } }
      })
      expect(hostJournal().submissions()).toHaveLength(0)
      expect(
        store
          .listOperationRows()
          .find((row) => row.operationId === params.envelope.clientOperationId)
      ).toBeUndefined()
      expect(
        store.readCommandReceipt({ kind: 'global' }, params.envelope.clientOperationId)
      ).toEqual({ verdict: 'absent' })
      expect(dispatch).not.toHaveBeenCalled()
      db.exec('DROP TRIGGER fail_receipt')
      await expect(host.send(CALLER, params)).resolves.toMatchObject({ ok: true, replayed: false })
      await deliveredOnce()
    }
  )

  it('answers unknown for an unreadable receipt and never runs the message again', async () => {
    await attach()
    const params = sendParams('accepted before corruption')
    await host.send(CALLER, params)
    await deliveredOnce()
    openTestJournalHostDatabase(root)
      .db.prepare(
        "UPDATE agent_session_command_receipts SET result_json = '{' WHERE operation_id = ?"
      )
      .run(params.envelope.clientOperationId)
    await expect(host.send(CALLER, params)).resolves.toMatchObject({
      ok: false,
      refusal: { code: 'agent_session_operation_unknown', details: { reason: 'outcomeUnknown' } }
    })
    expect(dispatch).toHaveBeenCalledTimes(1)
  })

  it('answers an in-transaction duplicate from the receipt after rolling back the second append', async () => {
    await attach()
    const params = sendParams('accepted once')
    await host.send(CALLER, params)
    await deliveredOnce()
    const journal = hostJournal()
    await journal.rollEpoch('schema_unreadable', store.getRecord(SESSION)!.lease.runtimeFence)
    const before = journal.cursor()
    vi.spyOn(store, 'readCommandReceipt').mockReturnValueOnce({ verdict: 'absent' })
    await expect(host.send(CALLER, params)).resolves.toMatchObject({
      ok: true,
      replayed: true,
      value: { submission: { clientMessageId: params.envelope.clientOperationId } }
    })
    expect(journal.cursor()).toEqual(before)
    expect(journal.submissions()).toHaveLength(0)
    expect(dispatch).toHaveBeenCalledTimes(1)
  })

  it('returns the committed send through receipt replay after publication fails', async () => {
    await attach()
    const params = sendParams('accepted before publication failed')
    const journal = hostJournal()
    const error = new Error('publication failed')
    journal.observeCommits(
      vi.fn().mockImplementationOnce(() => {
        throw error
      })
    )
    await expect(host.send(CALLER, params)).resolves.toMatchObject({
      ok: true,
      replayed: true,
      value: { submission: { dispatchState: 'pending' } }
    })
    expect(hostTestState().log.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          fields: expect.objectContaining({ scope: 'send-journal-write', error })
        }),
        expect.objectContaining({
          fields: expect.objectContaining({
            scope: 'command-receipt-publication',
            refusal: 'agent_session_operation_invalid'
          })
        })
      ])
    )
    expect(journal.submissions()).toHaveLength(1)
    await expect(host.send(CALLER, params)).resolves.toMatchObject({ ok: true, replayed: true })
    journal.observeCommits(() => {})
    await deliveredOnce()
  })
})

it('keeps a same-fingerprint ledger row unchanged while writing the Send receipt', async () => {
  await attach()
  const params = sendParams('accepted with prior compatibility identity')
  await store.admitGlobalOperation({
    callerKey: 'original-caller',
    operationId: params.envelope.clientOperationId,
    fingerprint: params.envelope.payloadFingerprint,
    now: NOW
  })
  const prior = store
    .listOperationRows()
    .find((row) => row.operationId === params.envelope.clientOperationId)
  await expect(host.send(CALLER, params)).resolves.toMatchObject({ ok: true, replayed: false })
  expect(
    store.listOperationRows().find((row) => row.operationId === params.envelope.clientOperationId)
  ).toEqual(prior)
  expect(
    store.readCommandReceipt({ kind: 'global' }, params.envelope.clientOperationId)
  ).toMatchObject({
    verdict: 'readable',
    receipt: { status: 'accepted', fingerprint: params.envelope.payloadFingerprint }
  })
  await deliveredOnce()
})

it('preserves global conflicts with a non-chat operation already in the ledger', async () => {
  await attach()
  const params = sendParams('cannot reuse a terminal launch')
  await store.admitOperation({
    callerKey: 'terminal-caller',
    operationId: params.envelope.clientOperationId,
    fingerprint: 'different-terminal-launch',
    now: NOW
  })
  await expect(host.send(CALLER, params)).resolves.toMatchObject({
    ok: false,
    refusal: { code: 'agent_session_operation_conflict', details: { reason: 'operationIdReused' } }
  })
  expect(hostJournal().submissions()).toHaveLength(0)
  expect(store.readCommandReceipt({ kind: 'global' }, params.envelope.clientOperationId)).toEqual({
    verdict: 'absent'
  })
})
