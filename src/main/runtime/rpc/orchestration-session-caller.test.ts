import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import 'zod'

import './core'
import './methods/orchestration/orchestration'

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
} from './orchestration-session-caller-test-fixture'
import './orchestration-session-caller'
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
