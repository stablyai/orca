import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import 'zod'

import './core'
import './methods/orchestration/orchestration'
import { AUTOMATION_METHODS } from './methods/automations/automations'
import { CONNECTOR_METHODS } from './methods/connectors/connector'
import { RpcDispatcher } from './dispatcher'
import { ORCHESTRATION_SESSION_CALLER_ERROR_CODES as CODES } from '../../../shared/orchestration/orchestration-session-caller-codes'
import {
  ADDRESS_X,
  createSessionCallerHarness,
  orchestrationRequest,
  idOf,
  resultOf,
  SESSION_X,
  SESSION_Y,
  sessionRecord,
  type SessionCallerHarness
} from './orchestration/callers/session.test-fixture'
import './orchestration/callers/orchestration-session-caller'
import '../orchestration/addressing/orchestration-party'

const hostRef = vi.hoisted((): { current: unknown } => ({ current: null }))
vi.mock('../../native-chat/agent-session-wire/host/structured-agent-session-registry', () => ({
  getStructuredAgentSessionHost: () => hostRef.current
}))

describe('orchestration session callers at the dispatch entry', () => {
  let h: SessionCallerHarness

  beforeEach(() => {
    h = createSessionCallerHarness(hostRef)
  })

  afterEach(() => {
    h.close()
    vi.restoreAllMocks()
  })

  it('verifies the session behind an automation write, refusing one that is not on this host', async () => {
    const create = vi.spyOn(h.runtime, 'createAutomation')
    const dispatcher = new RpcDispatcher({ runtime: h.runtime, methods: AUTOMATION_METHODS })
    const response = await dispatcher.dispatch({
      ...orchestrationRequest(
        'automation.create',
        { name: 'n', prompt: 'p', agentId: 'codex', rrule: 'FREQ=DAILY', dtstart: 0 },
        { sessionId: '99999999-9999-4999-8999-999999999999' }
      ),
      orchestrationContractVersion: undefined
    })
    expect(response).toMatchObject({ ok: false, error: { code: CODES.unknown } })
    expect(create).not.toHaveBeenCalled()
  })

  it.each(['connector.act', 'connector.reply'])(
    'verifies the session behind %s, which posts as a bot chat',
    async (method) => {
      const dispatcher = new RpcDispatcher({ runtime: h.runtime, methods: CONNECTOR_METHODS })
      const response = await dispatcher.dispatch({
        ...orchestrationRequest(
          method,
          { sessionId: SESSION_X, verb: 'post', ref: 'slack:T:C', text: 'hi' },
          { sessionId: '99999999-9999-4999-8999-999999999999' }
        ),
        orchestrationContractVersion: undefined
      })
      expect(response).toMatchObject({ ok: false, error: { code: CODES.unknown } })
    }
  )

  describe('a declared caller must name the session', () => {
    it('accepts a /clear successor naming the address it had before the clear, and no other', async () => {
      // Y continued X after a /clear, so X's address is Y's: the lineage root names the chat.
      h.records.set(SESSION_X, {
        ...sessionRecord(SESSION_X),
        conversationCommand: {
          command: 'clear',
          state: 'completed',
          replacementSessionId: SESSION_Y,
          operationId: 'op',
          callerKey: 'caller',
          phase: 'committed'
        }
      })
      const run = resultOf(
        await h.dispatch(
          orchestrationRequest(
            'orchestration.runCreate',
            { objective: 'o', from: ADDRESS_X },
            { sessionId: SESSION_Y }
          )
        )
      ).run
      expect(h.db.getRunRaw(idOf(run))?.coordinator_orca_session_id).toBe(SESSION_X)

      const stranger = 'orca_session_id:0b5e2d7c-9a41-4c3e-8f62-7d1a3e5b9c08'
      const refused = await h.dispatch(
        orchestrationRequest(
          'orchestration.runCreate',
          { objective: 'o', from: stranger },
          { sessionId: SESSION_Y }
        )
      )
      expect(refused).toMatchObject({ ok: false, error: { code: 'consumer_fenced' } })
    })
  })
})
