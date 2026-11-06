import { describe, expect, it, vi } from 'vitest'
import type { StructuredAgentSessionState } from '../../../src/shared/agent-session/structured-agent-session-reducer'
import type { RpcClient } from '../transport/rpc-client'
import { markRpcDeliveryUnknown } from '../transport/rpc-delivery-ambiguity'
import { requestMobileStructuredAgentSessionCancel } from './mobile-structured-agent-session-cancel'

type SentParams = { envelope: { clientOperationId: string } }

function fakeClient(
  sendRequest: (method: string, params: SentParams) => Promise<unknown>
): RpcClient {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: both paths under test reach only `sendRequest`.
  return { sendRequest } as unknown as RpcClient
}

function runningState(): StructuredAgentSessionState {
  const state = {
    fence: 3,
    items: [
      {
        itemId: 'status-1',
        revision: 1,
        sequence: 1,
        observedAt: 10,
        body: {
          kind: 'status',
          text: 'Working',
          turnLifecycle: { turnId: 'turn-1', state: 'running' }
        }
      }
    ]
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: cancel reads only the fence and the running turn.
  return state as unknown as StructuredAgentSessionState
}

function cancelArgs(client: RpcClient, hostAnswersRepeatedStops: boolean | null = false) {
  return {
    client,
    sessionId: 'session-1',
    enabled: true,
    stateRef: { current: runningState() },
    promptCancelSupported: null,
    hostAnswersRepeatedStops,
    hostStopsConversation: null,
    inFlight: new Map<string, Promise<boolean>>(),
    onSendError: vi.fn()
  }
}

describe('structured Stop after an unknown outcome', () => {
  it('stops on a second press after the first lost its answer', async () => {
    const ran = new Set<string>()
    let lostAnswers = 1
    const client = fakeClient(async (_method, params) => {
      // As the host's ledger does: an id it already ran replays as handled and stops nothing.
      const operationId = params.envelope.clientOperationId
      const cancelled = !ran.has(operationId)
      ran.add(operationId)
      if (lostAnswers > 0) {
        lostAnswers -= 1
        throw markRpcDeliveryUnknown(new Error('Connection closed'))
      }
      return {
        ok: true,
        result: { ok: true, value: { turnId: 'turn-1', cancelled } },
        _meta: { runtimeId: 'runtime-1' }
      }
    })
    const args = cancelArgs(client)

    expect(await requestMobileStructuredAgentSessionCancel(args)).toBe(false)
    expect(await requestMobileStructuredAgentSessionCancel(args)).toBe(true)

    expect(ran.size).toBe(2)
  })
})
