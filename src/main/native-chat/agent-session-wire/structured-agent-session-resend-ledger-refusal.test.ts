import { deleteTestOperationLedger } from '../agent-session-journal/journal-retained-fault-test-support'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { AGENT_SESSION_MAX_NEW_OPERATION_AGE_MS } from '../../../shared/agent-session/agent-session-host-authority'

import { openTestJournalHostDatabase } from '../agent-session-journal/journal-host-database-test-support'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import type { StructuredAgentSessionHost } from './structured-agent-session-host'
import {
  attach,
  CALLER,
  envelope,
  hostTestState
} from './structured-agent-session-host-test-harness'
import { HOST_TEST_NOW as NOW, hostTestMessage } from './structured-agent-session-host-test-data'

let root: string
let host: StructuredAgentSessionHost
let dispatch: Mock<StructuredAgentSessionAdapter['dispatch']>

beforeEach(() => {
  ;({ root, host, dispatch } = hostTestState())
})

afterEach(() => vi.restoreAllMocks())

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
  it('replays accepted ids after the compatibility ledger has expired', async () => {
    await attach()
    const params = sendParams('receipt survives the ledger')
    await host.send(CALLER, params)
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1))
    await deleteTestOperationLedger(await openTestJournalHostDatabase(root))
    await expect(host.send(CALLER, params)).resolves.toMatchObject({ ok: true, replayed: true })
    expect(dispatch).toHaveBeenCalledTimes(1)
  })
})

describe('a /clear in flight', () => {
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
