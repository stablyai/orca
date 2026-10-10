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

function cancelArgs(client: RpcClient, hostAnswersRepeatedStops: boolean | null = false) {
  return {
    client,
    sessionId: 'session-1',
    enabled: true,
    stateRef: { current: runningState() },
    promptCancelSupported: null,
    hostAnswersRepeatedStops,
    inFlight: new Map<string, Promise<boolean>>(),
    onSendError: vi.fn()
  }
}

describe('structured mutation id retirement', () => {
  it('reports a host that cannot say what became of the id as unknown', async () => {
    const result = await requestStructuredAgentSessionMutation({
      client: fakeClient(async () => operationRefusedAsUnknown()),
      method: 'agentSession.cancel',
      fingerprintMethod: 'agentSession.cancel',
      sessionId: 'session-1',
      expectedRuntimeFence: 3,
      fields: { turnId: 'turn-1' },
      clientOperationId: `1900000000000-${'a'.repeat(32)}`
    })

    expect(result).toEqual({ status: 'unknown' })
  })

  it('reports doubt about the transport as unknown', async () => {
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
    const args = cancelArgs(client)

    await requestMobileStructuredAgentSessionCancel(args)
    await requestMobileStructuredAgentSessionCancel(args)

    expect(sent).toHaveLength(2)
    // Reusing it earns the same refusal until the row expires, leaving Stop unusable.
    expect(sent[1]).not.toBe(sent[0])
  })

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

describe('a phone Stop pressed again', () => {
  function heldStops() {
    const answers: (() => void)[] = []
    const sent: string[] = []
    const client = fakeClient((_method, params) => {
      sent.push(params.envelope.clientOperationId)
      return new Promise((resolve) =>
        answers.push(() =>
          resolve({
            ok: true,
            result: { ok: true, value: { turnId: 'turn-1', cancelled: true } },
            _meta: { runtimeId: 'runtime-1' }
          })
        )
      )
    })
    return { client, sent, answerAll: () => answers.splice(0).forEach((answer) => answer()) }
  }

  it('against a host without the quiet repeated Stop, joins the Stop of that turn still on its way', async () => {
    const host = heldStops()
    const args = cancelArgs(host.client)

    const presses = [
      requestMobileStructuredAgentSessionCancel(args),
      requestMobileStructuredAgentSessionCancel(args)
    ]
    host.answerAll()

    expect(await Promise.all(presses)).toEqual([true, true])
    expect(host.sent).toHaveLength(1)
  })

  it('sends a new Stop once the first has settled', async () => {
    const host = heldStops()
    const args = cancelArgs(host.client)

    for (let press = 0; press < 2; press += 1) {
      const pressed = requestMobileStructuredAgentSessionCancel(args)
      host.answerAll()
      await pressed
    }

    expect(host.sent).toHaveLength(2)
    expect(host.sent[1]).not.toBe(host.sent[0])
    expect(args.inFlight.size).toBe(0)
  })

  it('against a host that answers a repeated Stop quietly, sends every press under its own id', async () => {
    const host = heldStops()
    const args = cancelArgs(host.client, true)

    const presses = [
      requestMobileStructuredAgentSessionCancel(args),
      requestMobileStructuredAgentSessionCancel(args)
    ]
    await vi.waitFor(() => expect(host.sent).toHaveLength(2))
    host.answerAll()

    expect(await Promise.all(presses)).toEqual([true, true])
    expect(host.sent[1]).not.toBe(host.sent[0])
    expect(args.inFlight.size).toBe(0)
  })
})

describe('what a structured refusal says on the phone', () => {
  it("replaces the host's diagnostic with words a person can act on", async () => {
    const result = await requestStructuredAgentSessionMutation({
      client: fakeClient(async () => ({
        ok: true,
        result: {
          ok: false,
          refusal: {
            code: 'agent_session_checkpoint_stale',
            message: 'Expected runtime fence 1; the session is at 3.'
          }
        },
        _meta: { runtimeId: 'runtime-1' }
      })),
      method: 'agentSession.send',
      fingerprintMethod: 'agentSession.send',
      sessionId: 'session-1',
      expectedRuntimeFence: 1,
      fields: { body: 'hello' },
      clientOperationId: `1900000000000-${'c'.repeat(32)}`
    })

    expect(result).toEqual({
      status: 'refused',
      code: 'agent_session_checkpoint_stale',
      message: 'Your message was not sent. Send it again.'
    })
  })

  it('says what the host named as the reason, in the same words as desktop', async () => {
    const result = await requestStructuredAgentSessionMutation({
      client: fakeClient(async () => ({
        ok: true,
        result: {
          ok: false,
          refusal: {
            code: 'agent_session_operation_invalid',
            message: 'This conversation has been cleared. Use the current conversation.',
            details: { reason: 'conversationCleared' }
          }
        },
        _meta: { runtimeId: 'runtime-1' }
      })),
      method: 'agentSession.send',
      fingerprintMethod: 'agentSession.send',
      sessionId: 'session-1',
      expectedRuntimeFence: 1,
      fields: { body: 'hello' },
      clientOperationId: `1900000000000-${'e'.repeat(32)}`
    })

    expect(result).toEqual({
      status: 'refused',
      code: 'agent_session_operation_invalid',
      message:
        'This conversation has been cleared. Your message was not sent. Open the current conversation to continue.'
    })
  })

  const stop = {
    method: 'agentSession.cancel',
    fingerprintMethod: 'agentSession.cancel',
    sessionId: 'session-1',
    expectedRuntimeFence: 1,
    fields: { turnId: 'turn-1' },
    clientOperationId: `1900000000000-${'d'.repeat(32)}`
  }

  it("keeps a failed request's transport text off the screen", async () => {
    const result = await requestStructuredAgentSessionMutation({
      ...stop,
      client: fakeClient(async () => {
        throw new Error('ECONNRESET 10.0.0.2:443')
      })
    })

    expect(result).toEqual({
      status: 'failed',
      message: "The agent wasn't stopped."
    })
  })

  it("keeps the host's text off the screen when it turns the request away unrun", async () => {
    const result = await requestStructuredAgentSessionMutation({
      ...stop,
      client: fakeClient(async () => ({
        ok: false,
        error: { code: 'method_not_found', message: 'Unknown method: agentSession.cancel' },
        _meta: { runtimeId: 'runtime-1' }
      }))
    })

    expect(result).toEqual({
      status: 'failed',
      message:
        'This needs a newer Orca on the computer running this chat. Update Orca there, then try again.'
    })
  })
})
