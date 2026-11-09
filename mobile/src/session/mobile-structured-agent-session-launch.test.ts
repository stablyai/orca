import { describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import { markRpcDeliveryUnknown } from '../transport/rpc/rpc-delivery-ambiguity'
import { createMobileStructuredAgentSession } from './mobile-structured-agent-session-launch'
import './mobile-created-structured-sessions'

function clientReturning(
  ...responses: unknown[]
): RpcClient & { sendRequest: ReturnType<typeof vi.fn> } {
  let responseIndex = 0
  const sendRequest = vi.fn(async () => responses[responseIndex++])
  return { sendRequest } as unknown as RpcClient & { sendRequest: ReturnType<typeof vi.fn> }
}

describe('mobile structured agent-session launch', () => {
  it('keeps the outcome unknown when the idempotent retry cannot be sent', async () => {
    const client = clientReturning({ ok: true, result: { supported: true } })
    client.sendRequest.mockImplementationOnce(async () => ({
      ok: true,
      result: { supported: true }
    }))
    client.sendRequest.mockRejectedValueOnce(markRpcDeliveryUnknown(new Error('response lost')))
    client.sendRequest.mockRejectedValueOnce(new Error('connection interrupted'))

    await expect(
      createMobileStructuredAgentSession(client, 'workspace-1', 'codex')
    ).resolves.toMatchObject({
      kind: 'unknown'
    })
  })
})

it('settles a proven missing-original fork refusal but keeps a lost earlier attempt unknown', async () => {
  const refusal = {
    ok: true,
    result: {
      ok: false,
      refusal: {
        code: 'agent_session_identity_required',
        details: { reason: 'recordMissing' },
        createAttemptRefusedBeforeCommit: true,
        message: 'Source chat unavailable'
      }
    }
  }
  const client = clientReturning({ ok: true, result: { supported: true } }, refusal)
  const forkFrom = { sessionId: 'copied-chat', throughItemId: 'legacy:opencode:source:reply-1' }
  expect(
    (await createMobileStructuredAgentSession(client, 'workspace-1', 'opencode', forkFrom)).kind
  ).toBe('failed')
  const lost = clientReturning({ ok: true, result: { supported: true } }, refusal)
  lost.sendRequest
    .mockImplementationOnce(async () => ({ ok: true, result: { supported: true } }))
    .mockRejectedValueOnce(markRpcDeliveryUnknown(new Error('reply lost')))
    .mockResolvedValueOnce(refusal)
  expect(
    (await createMobileStructuredAgentSession(lost, 'workspace-1', 'opencode', forkFrom)).kind
  ).toBe('unknown')
})
