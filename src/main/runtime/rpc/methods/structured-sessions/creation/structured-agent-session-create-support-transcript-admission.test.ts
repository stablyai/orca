import { EVERY_AGENT_CHAT } from '../../../../../../shared/native-chat/every-agent-chat.test-fixture'
// A resume's createSupport answer also refuses a transcript create could not adopt, before the
// client closes the conversation's terminal (#39942).

import { describe, expect, it, vi } from 'vitest'
import { agentSessionRefusalError } from '../../../../../../shared/agent-session/failures/agent-session-wire-refusals'
import { isAgentSessionCreateAdmissionRefusal } from '../../../../../../shared/agent-session/failures/agent-session-definitive-refusal'
import { STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY } from '../../../../../../shared/agent-session/agent-session-runtime-capabilities'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import type { RpcResponse } from '../../../core'
import { RpcDispatcher } from '../../../dispatcher'
import { STRUCTURED_AGENT_SESSION_METHODS } from '../structured-agent-session'

const WORKTREE = 'id:workspace-1'
const PROVIDER_SESSION_ID = 'claude-session-1'

const STRUCTURED_CLIENT = {
  clientKind: 'runtime' as const,
  clientCapabilities: [STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY]
}

async function createSupport(runtimeOverrides: Record<string, unknown>): Promise<RpcResponse> {
  const runtime = {
    getRuntimeId: () => 'runtime-1',
    // The launch-preference gate reads host settings, so every agent admits here.
    requireStore: () => ({ getSettings: () => ({ nativeChatProviders: EVERY_AGENT_CHAT }) }),
    getStructuredAgentSessionCreateSupport: vi.fn(async () => ({ supported: true })),
    assertStructuredAdoptionTerminalWritersExited: vi.fn(async () => undefined),
    structuredAgentSessionLaunchSeedOptions: vi.fn(() => undefined),
    ...runtimeOverrides
  }
  const replies: RpcResponse[] = []
  await new RpcDispatcher({
    runtime: runtime as unknown as OrcaRuntimeService,
    methods: STRUCTURED_AGENT_SESSION_METHODS
  }).dispatchStreaming(
    {
      id: 'request-1',
      authToken: 'token',
      method: 'agentSession.createSupport',
      params: {
        worktree: WORKTREE,
        agent: 'claude',
        resumeFrom: {
          providerSessionId: PROVIDER_SESSION_ID,
          closingPaneKeys: ['workspace-1:leaf-1']
        }
      }
    },
    (raw) => replies.push(JSON.parse(raw) as RpcResponse),
    STRUCTURED_CLIENT
  )
  const first = replies[0]
  if (!first) {
    throw new Error('no reply for agentSession.createSupport')
  }
  return first
}

function errorRefusal(reply: RpcResponse): Record<string, unknown> | undefined {
  if (reply.ok) {
    return undefined
  }
  const data = reply.error.data
  return typeof data === 'object' && data !== null
    ? (data as { refusal?: Record<string, unknown> }).refusal
    : undefined
}

describe('createSupport admission for a resumed CLI conversation', () => {
  it('refuses with the missing-transcript refusal the client can act on before closing the terminal', async () => {
    const transcriptReadable = vi.fn(async () => {
      throw agentSessionRefusalError('agent_session_identity_required', {
        reason: 'transcriptNotFound'
      })
    })
    const reply = await createSupport({
      assertStructuredAdoptionTranscriptReadable: transcriptReadable
    })

    expect(reply.ok).toBe(false)
    const refusal = errorRefusal(reply)
    expect(refusal).toMatchObject({
      code: 'agent_session_identity_required',
      details: { reason: 'transcriptNotFound' }
    })
    // The exact predicate that turns this reply into a refused admission on the client.
    expect(isAgentSessionCreateAdmissionRefusal(refusal as never)).toBe(true)
    expect(transcriptReadable).toHaveBeenCalledOnce()
  })

  it('still admits a resume whose transcript create can adopt', async () => {
    const reply = await createSupport({
      assertStructuredAdoptionTranscriptReadable: vi.fn(async () => undefined)
    })

    expect(reply.ok).toBe(true)
  })
})
