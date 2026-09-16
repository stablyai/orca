import { describe, expect, it, vi } from 'vitest'
import type { StructuredAgentSessionState } from '../../../src/shared/structured-agent-session-reducer'
import type { RpcClient } from '../transport/rpc-client'
import { markRpcDeliveryUnknown } from '../transport/rpc-delivery-ambiguity'
import { requestMobileStructuredAgentSessionCancel } from './mobile-structured-agent-session-cancel'
import { requestStructuredAgentSessionMutation } from './mobile-structured-agent-session-rpc'

type SentParams = { envelope: { clientOperationId: string } }

function operationRefusedAsUnknown() {
  return {
    ok: true,
    result: {
      ok: false,
      refusal: {
        code: 'agent_session_operation_unknown',
        message: 'The outcome of operation X is unknown; it was not run again.'
      }
    },
    _meta: { runtimeId: 'runtime-1' }
  }
}

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

function cancelArgs(client: RpcClient, operationIds: Map<string, string>) {
  return {
    client,
    sessionId: 'session-1',
    enabled: true,
    stateRef: { current: runningState() },
    sessionKey: 'key-1',
    operationIds,
    promptCancelSupported: null,
    onSendError: vi.fn()
  }
}

describe('structured mutation id retirement', () => {
  it('marks a host answer about the id apart from doubt about the effect', async () => {
    const result = await requestStructuredAgentSessionMutation({
      client: fakeClient(async () => operationRefusedAsUnknown()),
      method: 'agentSession.cancel',
      fingerprintMethod: 'agentSession.cancel',
      sessionId: 'session-1',
      expectedRuntimeFence: 3,
      fields: { turnId: 'turn-1' },
      clientOperationId: `1900000000000-${'a'.repeat(32)}`
    })

    expect(result).toEqual({ status: 'unknown', hostReportedOperationUnknown: true })
  })

  it('leaves the id replayable when only the transport was in doubt', async () => {
    const result = await requestStructuredAgentSessionMutation({
      client: fakeClient(async () => {
        throw markRpcDeliveryUnknown(new Error('Connection closed'))
      }),
      method: 'agentSession.cancel',
      fingerprintMethod: 'agentSession.cancel',
      sessionId: 'session-1',
      expectedRuntimeFence: 3,
      fields: { turnId: 'turn-1' },
      clientOperationId: `1900000000000-${'b'.repeat(32)}`
    })

    expect(result).toEqual({ status: 'unknown' })
  })
})

describe('structured Stop after an unknown outcome', () => {
  it('retries under a fresh id once the host has answered about the previous one', async () => {
    const sent: string[] = []
    const client = fakeClient(async (_method, params) => {
      sent.push(params.envelope.clientOperationId)
      return operationRefusedAsUnknown()
    })
    const operationIds = new Map<string, string>()
    const args = cancelArgs(client, operationIds)

    await requestMobileStructuredAgentSessionCancel(args)
    await requestMobileStructuredAgentSessionCancel(args)

    expect(sent).toHaveLength(2)
    // Reusing it earns the same refusal until the row expires, leaving Stop unusable.
    expect(sent[1]).not.toBe(sent[0])
    expect(operationIds.size).toBe(0)
  })

  it('replays the same id when the host never answered', async () => {
    const sent: string[] = []
    const client = fakeClient(async (_method, params) => {
      sent.push(params.envelope.clientOperationId)
      throw markRpcDeliveryUnknown(new Error('Connection closed'))
    })
    const operationIds = new Map<string, string>()
    const args = cancelArgs(client, operationIds)

    await requestMobileStructuredAgentSessionCancel(args)
    await requestMobileStructuredAgentSessionCancel(args)

    expect(sent).toHaveLength(2)
    // Nothing proves the first Stop missed, so the retry must stay a replay.
    expect(sent[1]).toBe(sent[0])
    expect(operationIds.size).toBe(1)
  })
})
