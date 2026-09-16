import { describe, expect, it } from 'vitest'
import { agentSessionOperationKey } from '../../shared/agent-session-operation-ledger'
import {
  admitAgentSessionGlobalOperationRow,
  admitAgentSessionOperationRow
} from './agent-session-operation-admission'

const NOW = 1_900_000_000_000
const OPERATION_ID = `${NOW}-${'a'.repeat(32)}`

describe('global agent-session operation admission', () => {
  it('replays the original row after the caller identity changes', () => {
    const first = admitAgentSessionOperationRow(new Map(), {
      callerKey: 'caller-before-reconnect',
      operationId: OPERATION_ID,
      fingerprint: 'send-fingerprint',
      now: NOW
    })

    const replay = admitAgentSessionGlobalOperationRow(first.rows, {
      callerKey: 'caller-after-reconnect',
      operationId: OPERATION_ID,
      fingerprint: 'send-fingerprint',
      now: NOW + 1
    })

    expect(replay.decision).toMatchObject({
      decision: 'replay',
      row: { callerKey: 'caller-before-reconnect' }
    })
    expect(replay.rows.has(agentSessionOperationKey('caller-after-reconnect', OPERATION_ID))).toBe(
      false
    )
  })

  it('refuses the same id under a different send fingerprint', () => {
    const first = admitAgentSessionOperationRow(new Map(), {
      callerKey: 'caller-before-reconnect',
      operationId: OPERATION_ID,
      fingerprint: 'first-send',
      now: NOW
    })

    expect(
      admitAgentSessionGlobalOperationRow(first.rows, {
        callerKey: 'caller-after-reconnect',
        operationId: OPERATION_ID,
        fingerprint: 'different-send',
        now: NOW + 1
      }).decision
    ).toEqual({ decision: 'refused', code: 'agent_session_operation_conflict' })
  })
})
