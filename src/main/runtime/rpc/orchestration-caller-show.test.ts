import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '../../../shared/orchestration/orchestration-session-caller-codes'

import {
  ADDRESS_X,
  createSessionCallerHarness,
  orchestrationRequest,
  resultOf,
  SESSION_X,
  SESSION_Y,
  sessionRecord,
  type SessionCallerHarness
} from './orchestration-session-caller-test-fixture'

const hostRef = vi.hoisted((): { current: unknown } => ({ current: null }))
vi.mock('../../native-chat/agent-session-wire/host/structured-agent-session-registry', () => ({
  getStructuredAgentSessionHost: () => hostRef.current
}))

describe('orchestration.callerShow: a session learns its Orca session ID from the host', () => {
  let h: SessionCallerHarness

  beforeEach(() => {
    h = createSessionCallerHarness(hostRef)
  })

  afterEach(() => {
    h.close()
    vi.restoreAllMocks()
  })

  function callerShow(options: Parameters<typeof orchestrationRequest>[2]) {
    return orchestrationRequest('orchestration.callerShow', {}, options)
  }

  it('gives the menu the Orca session ID each session of a cleared chat acts as', async () => {
    const cleared = sessionRecord(SESSION_X)
    h.records.set(SESSION_X, {
      ...cleared,
      conversationCommand: {
        command: 'clear',
        state: 'completed',
        replacementSessionId: SESSION_Y,
        operationId: 'op',
        callerKey: 'caller',
        phase: 'committed'
      }
    })

    for (const sessionId of [SESSION_X, SESSION_Y]) {
      const shown = resultOf(
        await h.dispatch(orchestrationRequest('orchestration.sessionAddress', { sessionId }))
      )
      const acting = resultOf(await h.dispatch(callerShow({ sessionId })))
      // One derivation: the conversation's root, which the successor copies and acts as too.
      expect(shown.orcaSessionId).toBe(ADDRESS_X)
      expect(acting.caller).toMatchObject({ orcaSessionId: shown.orcaSessionId })
    }
  })
})
