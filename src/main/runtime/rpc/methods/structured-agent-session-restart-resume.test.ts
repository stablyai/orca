import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  call,
  clearStructuredHostStub,
  STRUCTURED_CLIENT
} from './structured-agent-session-rpc.test-fixture'

describe('agentSession.restartResumable before the host exists', () => {
  const ensureStructuredAgentSessionHost = vi.fn(async () => undefined)
  const hasStructuredAgentSessionRecords = vi.fn(() => false)

  beforeEach(() => {
    clearStructuredHostStub()
    ensureStructuredAgentSessionHost.mockClear()
    hasStructuredAgentSessionRecords.mockReset().mockReturnValue(false)
  })

  afterEach(() => {
    clearStructuredHostStub()
  })

  it('answers an empty offer without starting the host when no chat was ever stored', async () => {
    const response = await call('agentSession.restartResumable', {}, STRUCTURED_CLIENT, {
      ensureStructuredAgentSessionHost,
      hasStructuredAgentSessionRecords
    })

    expect(response).toMatchObject({ ok: true, result: { sessions: [], failed: [] } })
    expect(ensureStructuredAgentSessionHost).not.toHaveBeenCalled()
  })

  it('starts the host to read the offer when a chat is stored', async () => {
    hasStructuredAgentSessionRecords.mockReturnValue(true)

    await call('agentSession.restartResumable', {}, STRUCTURED_CLIENT, {
      ensureStructuredAgentSessionHost,
      hasStructuredAgentSessionRecords
    })

    expect(ensureStructuredAgentSessionHost).toHaveBeenCalledOnce()
  })

  it('still refuses a client without the capability', async () => {
    const response = await call(
      'agentSession.restartResumable',
      {},
      { clientKind: 'mobile', clientCapabilities: [] },
      { ensureStructuredAgentSessionHost, hasStructuredAgentSessionRecords }
    )

    expect(response).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining('structured_agent_session_unsupported') }
    })
  })
})
