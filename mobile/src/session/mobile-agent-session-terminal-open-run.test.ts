import { describe, expect, it, vi } from 'vitest'
import type { AgentProviderSessionMetadata } from '../../../src/shared/agent-session-resume'
import type { RpcClient } from '../transport/rpc-client'
import type { RpcResponse } from '../transport/types'
import {
  AGENT_SESSION_TERMINAL_OPEN_FAILED,
  openMobileAgentSessionInTerminal
} from './mobile-agent-session-terminal-open-run'

const PROVIDER_SESSION: AgentProviderSessionMetadata = { key: 'session_id', id: 'provider-1' }

const TARGET = {
  worktreeId: 'worktree-1',
  sessionId: 'chat-1',
  agent: 'claude' as const,
  providerSession: PROVIDER_SESSION
}

function clientAnswering(response: RpcResponse) {
  const sendRequest = vi.fn(async () => response)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: an RPC client stub with the one member the caller uses.
  const client = { sendRequest } as unknown as RpcClient
  return { client, sendRequest }
}

function refused(error: { code: string; message: string; data?: unknown }): RpcResponse {
  return { id: 'rpc-1', ok: false, error }
}

describe('openMobileAgentSessionInTerminal', () => {
  it("resumes the tab's own conversation through the host, in the background", async () => {
    const { client, sendRequest } = clientAnswering({
      id: 'rpc-1',
      ok: true,
      result: { terminal: { handle: 'term-1' }, disposition: 'created' }
    })

    await openMobileAgentSessionInTerminal(client, TARGET)

    expect(sendRequest).toHaveBeenCalledWith(
      'terminal.ensureAgentSession',
      {
        kind: 'explicit',
        worktree: 'id:worktree-1',
        agent: 'claude',
        providerSession: PROVIDER_SESSION,
        presentation: 'background'
      },
      { timeoutMs: 15_000 }
    )
  })

  it('words a refusal that names a reason through the shared notice pipeline', async () => {
    const { client } = clientAnswering(
      refused({
        code: 'agent_session_conflict',
        message: 'agent_session_conflict',
        data: { refusal: { code: 'agent_session_conflict', details: { reason: 'ownerUnproven' } } }
      })
    )

    await expect(openMobileAgentSessionInTerminal(client, TARGET)).rejects.toThrow(
      'The previous agent in this chat may still be running. Reopen the chat to check again.'
    )
  })

  it('never shows the bare code, and keeps a host sentence that says more than it', async () => {
    const { client: coded } = clientAnswering(
      refused({
        code: 'agent_session_conflict',
        message: 'agent_session_conflict',
        data: {
          refusal: {
            code: 'agent_session_conflict',
            details: { reason: 'conversationHeldElsewhere' }
          }
        }
      })
    )
    const { client: worded } = clientAnswering(
      refused({
        code: 'runtime_error',
        message: 'Another chat is already using this conversation.'
      })
    )

    await expect(openMobileAgentSessionInTerminal(coded, TARGET)).rejects.toThrow(
      AGENT_SESSION_TERMINAL_OPEN_FAILED
    )
    await expect(openMobileAgentSessionInTerminal(worded, TARGET)).rejects.toThrow(
      'Another chat is already using this conversation.'
    )
  })
})
