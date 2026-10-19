// Send identity outlives the ledger policy; /clear still refuses a first run at its arrival.

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { AGENT_SESSION_MAX_NEW_OPERATION_AGE_MS } from '../../../shared/agent-session-host-authority'
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import { openTestJournalHostDatabase } from '../agent-session-journal/journal-host-database-test-support'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import type { StructuredAgentSessionHost } from './structured-agent-session-host'
import {
  attach,
  CALLER,
  envelope,
  hostTestState
} from './structured-agent-session-host-test-harness'
import {
  HOST_TEST_NOW as NOW,
  HOST_TEST_SESSION as SESSION,
  hostTestMessage
} from './structured-agent-session-host-test-data'

let root: string
let store: AgentSessionRecordStore
let host: StructuredAgentSessionHost
let dispatch: Mock<StructuredAgentSessionAdapter['dispatch']>

beforeEach(() => {
  ;({ root, store, host, dispatch } = hostTestState())
})

afterEach(() => vi.restoreAllMocks())

function hostJournal(): AgentSessionJournal {
  return (
    host as unknown as { sessions: Map<string, { journal: AgentSessionJournal }> }
  ).sessions.get(SESSION)!.journal
}

function sendParams(text: string, clientOperationId?: string) {
  const body = hostTestMessage(text)
  return {
    envelope: envelope(
      'agentSession.send',
      { body },
      clientOperationId ? { clientOperationId } : {}
    ),
    body
  }
}

/** An id minted more than a day ago, which no ledger row holds any more. */
function expiredParams(text: string) {
  return sendParams(
    text,
    `${NOW - AGENT_SESSION_MAX_NEW_OPERATION_AGE_MS - 60_000}-${'e'.repeat(32)}`
  )
}

function clear() {
  return host.conversationCommand(CALLER, {
    command: 'clear',
    envelope: envelope('agentSession.conversationCommand', { command: 'clear' })
  })
}

describe('send without ledger policy', () => {
  it('accepts an id older than 24 hours while its chat is closed', async () => {
    await attach()
    await host.close(SESSION, 'evict')

    await expect(host.send(CALLER, expiredParams('long gone'))).resolves.toMatchObject({
      ok: true,
      replayed: false
    })
    expect(host.hasSession(SESSION)).toBe(true)
  })

  it('still refuses a write to a newer database', async () => {
    await attach()
    const database = openTestJournalHostDatabase(root)
    Object.defineProperty(database, 'readOnly', { value: true })
    expect(store.readOnly).toBe(true)
    try {
      await expect(host.send(CALLER, expiredParams('long gone'))).resolves.toMatchObject({
        ok: false,
        refusal: { details: { reason: 'journalWrittenByNewerOrca' } }
      })
    } finally {
      // Teardown stops the live child, which writes.
      Object.defineProperty(database, 'readOnly', { value: false })
    }
  })

  it('accepts a six-minute future id without evaluating or writing admission', async () => {
    await attach()
    const evaluate = vi.spyOn(store, 'evaluateMutationOperation').mockImplementation(() => {
      throw new Error('ledger refuses admission')
    })
    const admit = vi
      .spyOn(store, 'admitMutationOperation')
      .mockRejectedValue(new Error('ledger full'))
    const params = sendParams('host clock is behind', `${NOW + 6 * 60_000}-${'f'.repeat(32)}`)
    await expect(host.send(CALLER, params)).resolves.toMatchObject({ ok: true, replayed: false })
    await expect(host.send(CALLER, params)).resolves.toMatchObject({ ok: true, replayed: true })
    expect(evaluate).not.toHaveBeenCalled()
    expect(admit).not.toHaveBeenCalled()
  })

  it('replays accepted ids after the compatibility ledger has expired', async () => {
    await attach()
    const params = sendParams('receipt survives the ledger')
    await host.send(CALLER, params)
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1))
    const db = openTestJournalHostDatabase(root).db
    db.prepare('DELETE FROM agent_session_operations').run()
    await expect(host.send(CALLER, params)).resolves.toMatchObject({ ok: true, replayed: true })
    expect(dispatch).toHaveBeenCalledTimes(1)
  })

  it.each(['invalid', '1-a', `${NOW}-${'a'.repeat(33)}`])('refuses malformed id %s', async (id) => {
    await attach()
    await expect(host.send(CALLER, sendParams('invalid', id))).resolves.toMatchObject({
      ok: false,
      refusal: { details: { reason: 'operationIdInvalid' } }
    })
    expect(dispatch).not.toHaveBeenCalled()
  })
})

describe('a /clear in flight', () => {
  it('answers a resend from the attempt queued ahead of it, delivering once', async () => {
    await attach()
    const journal = hostJournal()
    const append = journal.appendSubmission.bind(journal)
    const held = Promise.withResolvers<void>()
    // An earlier send holds the session's queue, so attempt 1 waits there when the clear arrives.
    vi.spyOn(journal, 'appendSubmission').mockImplementationOnce(async (...args) => {
      await held.promise
      return append(...args)
    })
    const earlier = host.send(CALLER, sendParams('holds the queue'))
    const params = sendParams('queued ahead of the clear')
    const id = params.envelope.clientOperationId
    const attempt = host.send(CALLER, params)
    await vi.waitFor(() => expect(journal.appendSubmission).toHaveBeenCalledTimes(1))

    const clearing = clear()
    const resent = host.send(CALLER, params)
    held.resolve()
    const [first, second] = await Promise.all([attempt, resent, earlier, clearing])

    expect(first).toMatchObject({ ok: true, replayed: false })
    expect(second).toMatchObject({
      ok: true,
      replayed: true,
      value: { submission: { clientMessageId: id } }
    })
    expect(journal.submissions().filter((entry) => entry.clientMessageId === id)).toHaveLength(1)
    expect(
      dispatch.mock.calls.filter(([input]) => input.clientMessageId === id).length
    ).toBeLessThanOrEqual(1)
  })

  it('refuses an old id only for the clear in flight', async () => {
    await attach()
    const clearing = clear()
    const expired = host.send(CALLER, expiredParams('typed long ago'))
    await clearing

    await expect(expired).resolves.toMatchObject({
      ok: false,
      refusal: { details: { reason: 'conversationCommandInFlight' } }
    })
  })
})
