import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  call,
  clearStructuredHostStub,
  hostCalls,
  installStructuredHostStub,
  SESSION,
  STRUCTURED_CLIENT
} from './structured-agent-session-rpc.test-fixture'

beforeEach(() => {
  installStructuredHostStub()
})

afterEach(() => {
  clearStructuredHostStub()
})

describe('agentSession.conversationOutline', () => {
  it('derives the outline from the host journal on each request', async () => {
    hostCalls.journalSnapshot.mockReturnValueOnce({
      sessionId: SESSION,
      cursor: { epoch: 'epoch-a', sequence: 12 },
      items: [
        {
          itemId: 'prompt-1',
          revision: 1,
          sequence: 4,
          observedAt: 4,
          body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'Fix it' }] }
        },
        {
          itemId: 'reply-1',
          revision: 1,
          sequence: 5,
          observedAt: 5,
          body: { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'Done' }] }
        }
      ],
      submissions: []
    })

    const response = await call(
      'agentSession.conversationOutline',
      { sessionId: SESSION },
      STRUCTURED_CLIENT
    )

    expect(hostCalls.journalSnapshot).toHaveBeenCalledWith(SESSION)
    expect(response).toMatchObject({
      ok: true,
      result: {
        sessionId: SESSION,
        cursor: { epoch: 'epoch-a', sequence: 12 },
        entries: [{ itemId: 'prompt-1', sequence: 4, preview: 'Fix it', imageCount: 0 }],
        omittedEntries: 0
      }
    })
  })

  it('refuses a client that never negotiated structured sessions', async () => {
    const response = await call(
      'agentSession.conversationOutline',
      { sessionId: SESSION },
      { clientKind: 'runtime', clientCapabilities: [] }
    )
    expect(response).toMatchObject({ ok: false })
    expect(hostCalls.journalSnapshot).not.toHaveBeenCalled()
  })
})
