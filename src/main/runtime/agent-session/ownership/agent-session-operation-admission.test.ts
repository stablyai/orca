import { describe, expect, it } from 'vitest'
import {
  agentSessionOperationKey,
  agentSessionOperationExpiry,
  pendingAgentSessionOperationRow,
  pruneAgentSessionOperationRows,
  type AgentSessionOperationRow
} from '../../../../shared/agent-session/lifecycle/agent-session-operation-ledger'
import {
  admitAgentSessionGlobalOperationRow,
  admitAgentSessionOperationRow,
  insertAcceptedAgentSessionOperationInto,
  retirePreparedAgentLaunchInto
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
    ).toEqual({
      decision: 'refused',
      code: 'agent_session_operation_conflict',
      details: { reason: 'operationIdReused' }
    })
  })
})

it('expires the compatibility success row from host time even for a far-future id', () => {
  const operationId = `${9_999_999_999_999}-${'b'.repeat(32)}`
  const state = { operations: new Map<string, AgentSessionOperationRow>() }
  insertAcceptedAgentSessionOperationInto(state, {
    callerKey: 'client',
    operationId,
    fingerprint: 'accepted',
    now: NOW,
    operationIdScope: 'global',
    outcome: { status: 'succeeded', sessionId: 'chat' }
  })
  const expiresAt = agentSessionOperationExpiry(NOW, NOW)
  expect(state.operations.get(agentSessionOperationKey('client', operationId))).toMatchObject({
    recordedAt: NOW,
    expiresAt,
    outcome: { status: 'succeeded' }
  })
  expect(pruneAgentSessionOperationRows(state.operations, expiresAt - 1).size).toBe(1)
  expect(pruneAgentSessionOperationRows(state.operations, expiresAt).size).toBe(0)
})

type Rows = Map<string, AgentSessionOperationRow>

/** A ledger that counts exact reads and every walk over it. */
class CountedRows extends Map<string, AgentSessionOperationRow> {
  reads = 0
  walks = 0
  override get(key: string): AgentSessionOperationRow | undefined {
    this.reads++
    return super.get(key)
  }
  override [Symbol.iterator](): ReturnType<Rows['entries']> {
    this.walks++
    return super[Symbol.iterator]()
  }
  override entries(): ReturnType<Rows['entries']> {
    this.walks++
    return super.entries()
  }
  override values(): ReturnType<Rows['values']> {
    this.walks++
    return super.values()
  }
}

describe('prepared launch retirement', () => {
  it.each([10, 100])(
    'retires and records 10 launches among %i unrelated rows by exact key',
    (unrelated) => {
      const operations = new CountedRows()
      const row = (callerKey: string, index: number) =>
        pendingAgentSessionOperationRow({
          callerKey,
          operationId: `${NOW}-${String(index).padStart(32, '0')}`,
          fingerprint: 'fingerprint',
          now: NOW
        })
      for (let index = 0; index < unrelated; index++) {
        const other = row('other-caller', index)
        operations.set(agentSessionOperationKey(other.callerKey, other.operationId), other)
      }
      const launches = Array.from({ length: 10 }, (_, index) => ({
        ...row('worktree-startup', unrelated + index),
        preparedLaunch: { daemonGeneration: 'daemon', reservationGeneration: `r-${index}` }
      }))
      for (const launch of launches) {
        operations.set(agentSessionOperationKey(launch.callerKey, launch.operationId), launch)
      }
      const state = { operations }
      const retire = (launch: (typeof launches)[number]) =>
        retirePreparedAgentLaunchInto(state, {
          callerKey: 'worktree-startup',
          operationId: launch.operationId,
          daemonGeneration: 'daemon',
          reservationGeneration: launch.preparedLaunch.reservationGeneration,
          outcome: {
            status: 'failed',
            code: 'spawn-failed',
            message: 'Codex could not be started.'
          }
        })

      operations.reads = 0
      // Only the first retirement of each removes it; a replay finds no descriptor and changes nothing.
      expect(launches.map(retire)).toEqual(launches.map(() => true))
      expect(launches.map(retire)).toEqual(launches.map(() => false))
      // Two exact reads per launch and no walk, however large the rest of the ledger is.
      expect(operations.reads).toBe(20)
      expect(operations.walks).toBe(0)
      const saved = operations.get(
        agentSessionOperationKey('worktree-startup', launches[0]!.operationId)
      )
      expect(saved).not.toHaveProperty('preparedLaunch')
      expect(saved?.outcome).toEqual({
        status: 'failed',
        code: 'spawn-failed',
        message: 'Codex could not be started.'
      })
    }
  )
})
