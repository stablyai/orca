// A send id the ledger refuses is answered with that refusal and nothing else: no chat opened, no
// write. A /clear in flight refuses only a send's first run, judged when the send arrived.

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

const EXPIRED = {
  ok: false,
  refusal: {
    code: 'agent_session_operation_expired',
    details: { reason: 'operationExpired' }
  }
}

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

describe('an expired send id', () => {
  it('is answered expired while its chat is closed, not as a chat this host lacks', async () => {
    await attach()
    await host.close(SESSION, 'evict')

    await expect(host.send(CALLER, expiredParams('long gone'))).resolves.toMatchObject(EXPIRED)
    expect(host.hasSession(SESSION)).toBe(false)
  })

  it('is answered expired by a store a newer Orca wrote', async () => {
    await attach()
    const database = openTestJournalHostDatabase(root)
    Object.defineProperty(database, 'readOnly', { value: true })
    expect(store.readOnly).toBe(true)
    try {
      await expect(host.send(CALLER, expiredParams('long gone'))).resolves.toMatchObject(EXPIRED)
    } finally {
      // Teardown stops the live child, which writes.
      Object.defineProperty(database, 'readOnly', { value: false })
    }
  })

  it('is answered expired when its row lapses while the chat opens for the resend', async () => {
    await attach()
    const params = sendParams('recorded, then it lapsed')
    await host.send(CALLER, params)
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1))
    const evaluate = store.evaluateMutationOperation
    // The second read, after the open, sees the clock past the row's whole retention.
    vi.spyOn(store, 'evaluateMutationOperation')
      .mockImplementationOnce(evaluate)
      .mockImplementationOnce((args) =>
        evaluate({ ...args, now: args.now + 3 * AGENT_SESSION_MAX_NEW_OPERATION_AGE_MS })
      )

    await expect(host.send(CALLER, params)).resolves.toMatchObject(EXPIRED)
    expect(dispatch).toHaveBeenCalledTimes(1)
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

  it('answers an expired id expired', async () => {
    await attach()
    const clearing = clear()
    const expired = host.send(CALLER, expiredParams('typed long ago'))
    await clearing

    await expect(expired).resolves.toMatchObject(EXPIRED)
  })
})
