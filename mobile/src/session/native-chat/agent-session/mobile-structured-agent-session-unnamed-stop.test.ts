import { describe, expect, it, vi } from 'vitest'
import type { StructuredAgentSessionState } from '../../../../../src/shared/agent-session/structured-agent-session-reducer'
import type { RpcClient } from '../../../transport/rpc/rpc-client-contract'
import { requestMobileStructuredAgentSessionCancel } from '../../mobile-structured-agent-session-cancel'

type SentParams = Record<string, unknown> & { envelope: { clientOperationId: string } }

function recordingClient(sent: SentParams[]): RpcClient {
  const sendRequest = async (_method: string, params: SentParams) => {
    sent.push(params)
    return { ok: true, result: { ok: true, value: { cancelled: true } }, _meta: { runtimeId: 'r' } }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: cancel reaches only `sendRequest`.
  return { sendRequest } as unknown as RpcClient
}

function state(turnId: string | null): StructuredAgentSessionState {
  const items = turnId
    ? [
        {
          itemId: 'status-1',
          revision: 1,
          sequence: 1,
          observedAt: 10,
          body: { kind: 'status', text: 'Working', turnLifecycle: { turnId, state: 'running' } }
        }
      ]
    : []
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: cancel reads only the fence and the running turn.
  return { fence: 3, items } as unknown as StructuredAgentSessionState
}

function press(input: {
  sent: SentParams[]
  turnId: string | null
  hostStopsConversation: boolean | null
  prompt?: { itemId: string; expectedRevision: number }
  promptCancelSupported?: boolean
}) {
  const onSendError = vi.fn()
  const pressed = requestMobileStructuredAgentSessionCancel({
    client: recordingClient(input.sent),
    sessionId: 'session-1',
    enabled: true,
    stateRef: { current: state(input.turnId) },
    promptCancelSupported: input.promptCancelSupported ?? true,
    ...(input.prompt ? { prompt: input.prompt } : {}),
    hostAnswersRepeatedStops: true,
    hostStopsConversation: input.hostStopsConversation,
    inFlight: new Map(),
    onSendError
  })
  return { pressed, onSendError }
}

describe('phone Stop against a host that stops what the chat has in flight', () => {
  it('names no turn while a turn runs either', async () => {
    const sent: SentParams[] = []
    expect(await press({ sent, turnId: 'turn-1', hostStopsConversation: true }).pressed).toBe(true)
    expect(sent[0]).not.toHaveProperty('turnId')
  })

  it("keeps naming a card's turn when the host cannot take the card's identity", async () => {
    const sent: SentParams[] = []
    const prompt = { itemId: 'prompt-1', expectedRevision: 2 }
    await press({
      sent,
      turnId: 'turn-1',
      hostStopsConversation: true,
      prompt,
      promptCancelSupported: false
    }).pressed
    expect(sent[0]).toMatchObject({ turnId: 'turn-1' })
    expect(sent[0]).not.toHaveProperty('prompt')
  })
})
