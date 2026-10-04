import { describe, expect, it } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import {
  agentSessionReadFailureText,
  callAgentSession,
  requestStructuredAgentSessionMutation
} from './mobile-structured-agent-session-rpc'

// As `mapRuntimeError` sends a thrown refusal (pinned in `src/main/runtime/rpc/errors.test.ts`):
// its message is the bare code, and its reason rides in data.
const THROWN_JOURNAL_REFUSAL = {
  code: 'runtime_error',
  message: 'agent_session_journal_unreadable',
  data: {
    refusal: {
      code: 'agent_session_journal_unreadable',
      details: { reason: 'journalCorrupt' }
    }
  }
}

function refusingClient(): RpcClient {
  const sendRequest = async () => ({ id: 'req-1', ok: false, error: THROWN_JOURNAL_REFUSAL })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the paths under test reach only `sendRequest`.
  return { sendRequest } as unknown as RpcClient
}

describe('a refusal the host threw', () => {
  it("reads a chat's history failure in the refusal's words, from a stream or a request", async () => {
    const words = 'Unable to load this chat.'
    // The stream's error frame, as the RPC client hands it over.
    expect(
      agentSessionReadFailureText({
        type: 'error',
        message: THROWN_JOURNAL_REFUSAL.message,
        error: THROWN_JOURNAL_REFUSAL
      })
    ).toBe(words)
    const thrown = await callAgentSession(refusingClient(), 'agentSession.history', {}).catch(
      (error: unknown) => error
    )
    expect(agentSessionReadFailureText(thrown)).toBe(words)
    expect(agentSessionReadFailureText({ type: 'error', message: 'Connection interrupted' })).toBe(
      'Connection interrupted'
    )
  })

  it("fails a write with the refusal's words, not as unconfirmed", async () => {
    const result = await requestStructuredAgentSessionMutation({
      client: refusingClient(),
      method: 'agentSession.cancel',
      fingerprintMethod: 'agentSession.cancel',
      sessionId: 'session-1',
      expectedRuntimeFence: 3,
      fields: { turnId: 'turn-1' },
      clientOperationId: `1900000000000-${'c'.repeat(32)}`
    })

    expect(result).toEqual({
      status: 'failed',
      message: "Unable to load this chat. The agent wasn't stopped."
    })
  })
})

describe('a write refused on a journal a newer Orca wrote', () => {
  // As the host answers it (pinned in `journal-open-failure.test.ts`).
  const newerOrcaClient = (): RpcClient => {
    const sendRequest = async () => ({
      id: 'req-1',
      ok: true,
      result: {
        ok: false,
        refusal: {
          code: 'agent_session_journal_unreadable',
          message: 'Chats were saved by a newer Orca. Update Orca to keep using them.',
          details: { reason: 'journalWrittenByNewerOrca' }
        }
      }
    })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the paths under test reach only `sendRequest`.
    return { sendRequest } as unknown as RpcClient
  }

  it.each([
    [
      'agentSession.send',
      { body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'hello' }] } },
      'Chats were saved by a newer Orca. Your message was not sent. Update Orca to keep using them.'
    ],
    [
      'agentSession.cancel',
      { turnId: 'turn-1' },
      "Chats were saved by a newer Orca. The agent wasn't stopped. Update Orca to keep using them."
    ]
  ] as const)('says to update Orca for %s', async (method, fields, message) => {
    const result = await requestStructuredAgentSessionMutation({
      client: newerOrcaClient(),
      method,
      fingerprintMethod: method,
      sessionId: 'session-1',
      expectedRuntimeFence: 3,
      fields,
      clientOperationId: `1900000000000-${'d'.repeat(32)}`
    })

    expect(result).toEqual({
      status: 'refused',
      code: 'agent_session_journal_unreadable',
      message
    })
  })
})
