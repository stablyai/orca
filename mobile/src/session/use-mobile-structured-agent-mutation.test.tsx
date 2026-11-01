import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { expect, it, vi } from 'vitest'
import { createFakeRpcClient } from '../mobile-web-shell/bridge-host-test-fakes'
import { markRpcDeliveryUnknown } from '../transport/rpc-delivery-ambiguity'
import {
  EMPTY_STRUCTURED_AGENT_SESSION,
  type StructuredAgentSessionState
} from '../../../src/shared/structured-agent-session-reducer'
import {
  useMobileStructuredAgentMutate,
  type MobileStructuredAgentMutate
} from './use-mobile-structured-agent-mutation'

it('preserves the original whole-form operation, fence and hash across explicit unknown retries', async () => {
  const client = createFakeRpcClient()
  const send = vi
    .fn()
    .mockRejectedValueOnce(markRpcDeliveryUnknown(new Error('ACK lost')))
    .mockRejectedValueOnce(new Error('Disconnected'))
    .mockResolvedValue({ id: 'wire', ok: true, result: { ok: true, value: { accepted: true } } })
  client.sendRequest = send
  const stateRef: { current: StructuredAgentSessionState } = {
    current: { ...EMPTY_STRUCTURED_AGENT_SESSION, fence: 7 }
  }
  let mutate!: MobileStructuredAgentMutate
  const error = vi.fn()
  function Probe() {
    mutate = useMobileStructuredAgentMutate({
      client,
      sessionId: 'session-alpha',
      enabled: true,
      stateRef,
      onSendError: error
    })
    return null
  }
  let tree!: ReactTestRenderer
  try {
    await act(async () => {
      tree = create(createElement(Probe))
    })
    const fields = {
      itemId: 'form-1',
      expectedRevision: 4,
      content: { empty: '', whitespace: '  ', count: 0, confirmed: false }
    }
    // Keep the pending address present while the explicit retry uses its original press authority.
    stateRef.current = {
      ...stateRef.current,
      items: [
        {
          itemId: fields.itemId,
          revision: 4,
          sequence: 1,
          observedAt: 1,
          body: {
            kind: 'approval',
            title: 'Form',
            detail: null,
            options: [],
            resolution: {
              state: 'pending',
              selectedOptionId: null,
              resolvedAt: null,
              resolvedBy: null
            }
          }
        }
      ]
    }
    expect(
      await mutate('agentSession.respondToApproval', 'agentSession.respondTo:approval', fields)
    ).toEqual({ status: 'unknown' })
    stateRef.current = { ...stateRef.current, fence: 8 }
    expect(
      await mutate('agentSession.respondToApproval', 'agentSession.respondTo:approval', fields)
    ).toEqual({ status: 'unknown' })
    expect(
      await mutate('agentSession.respondToApproval', 'agentSession.respondTo:approval', {
        ...fields,
        content: { confirmed: false, count: 0, whitespace: '  ', empty: '' }
      })
    ).toMatchObject({ status: 'accepted', sameFence: false })
    const envelopes = send.mock.calls.map(([, params]) => params.envelope)
    expect(envelopes).toEqual([envelopes[0], envelopes[0], envelopes[0]])
    expect(envelopes[0].expectedRuntimeFence).toBe(7)
    expect(error).not.toHaveBeenCalled()
  } finally {
    await act(async () => tree?.unmount())
  }
})
