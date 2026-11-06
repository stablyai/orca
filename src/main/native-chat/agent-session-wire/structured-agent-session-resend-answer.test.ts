import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionRecordStore } from '../../runtime/agent-session/records/agent-session-record-store'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
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
  hostTestMessage
} from './structured-agent-session-host-test-data'
let store: AgentSessionRecordStore
let host: StructuredAgentSessionHost

beforeEach(() => {
  ;({ store, host } = hostTestState())
})

afterEach(() => vi.restoreAllMocks())

function hostJournal(): AgentSessionJournal {
  return host.collaboratorsForTests().sessions.get(SESSION)!.journal
}

describe('send receipt acceptance', () => {
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
})
