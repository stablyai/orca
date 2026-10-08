import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Database from '../sqlite/sync-database'
import { createAgentSessionRecordTablesSql } from '../native-chat/agent-session-journal/journal-database-schema'
import { AgentSessionOperationRepository } from './agent-session-operation-repository'
import {
  admitAgentSessionGlobalOperationInto,
  admitAgentSessionOperationInto
} from './agent-session-operation-admission'

const NOW = 1_900_000_000_000
const OPERATION_ID = `${NOW}-${'a'.repeat(32)}`
let db: Database.Database
let state: { operations: AgentSessionOperationRepository }
beforeEach(() => {
  db = new Database(':memory:')
  db.exec(createAgentSessionRecordTablesSql())
  state = { operations: new AgentSessionOperationRepository(() => db) }
  db.exec('BEGIN IMMEDIATE')
})
afterEach(() => db.close())

describe('global agent-session operation admission', () => {
  it('replays the original row after the caller identity changes', () => {
    admitAgentSessionOperationInto(state, {
      callerKey: 'caller-before-reconnect',
      operationId: OPERATION_ID,
      fingerprint: 'send-fingerprint',
      now: NOW
    })

    const replay = admitAgentSessionGlobalOperationInto(state, {
      callerKey: 'caller-after-reconnect',
      operationId: OPERATION_ID,
      fingerprint: 'send-fingerprint',
      now: NOW + 1
    })

    expect(replay).toMatchObject({
      decision: 'replay',
      row: { callerKey: 'caller-before-reconnect' }
    })
    expect(state.operations.get('caller-after-reconnect', OPERATION_ID)).toBeNull()
  })

  it('refuses the same id under a different send fingerprint', () => {
    admitAgentSessionOperationInto(state, {
      callerKey: 'caller-before-reconnect',
      operationId: OPERATION_ID,
      fingerprint: 'first-send',
      now: NOW
    })

    expect(
      admitAgentSessionGlobalOperationInto(state, {
        callerKey: 'caller-after-reconnect',
        operationId: OPERATION_ID,
        fingerprint: 'different-send',
        now: NOW + 1
      })
    ).toEqual({
      decision: 'refused',
      code: 'agent_session_operation_conflict',
      details: { reason: 'operationIdReused' }
    })
  })
})
