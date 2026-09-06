import { describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import { markRpcDeliveryUnknown } from '../transport/rpc-delivery-ambiguity'
import { createMobileStructuredCodexSession } from './mobile-structured-agent-session-launch'

function clientReturning(
  ...responses: unknown[]
): RpcClient & { sendRequest: ReturnType<typeof vi.fn> } {
  let responseIndex = 0
  const sendRequest = vi.fn(async () => responses[responseIndex++])
  return { sendRequest } as unknown as RpcClient & { sendRequest: ReturnType<typeof vi.fn> }
}

const acceptedCreateResult = {
  ok: true,
  replayed: false,
  fence: 1,
  cursor: { epoch: 'epoch-1', sequence: 0 },
  value: {
    sessionId: 'codex_session_1',
    fence: 1,
    page: {
      sessionId: 'codex_session_1',
      epoch: 'epoch-1',
      direction: 'tail',
      items: [],
      removedItemIds: [],
      submissions: [],
      window: { oldest: null, newest: null, nextCursor: { epoch: 'epoch-1', sequence: 0 } },
      liveCursor: { epoch: 'epoch-1', sequence: 0 },
      hasOlder: false,
      hasNewer: false
    },
    unconfirmedClientMessageIds: []
  }
}
const acceptedCreate = { ok: true, result: acceptedCreateResult }

describe('mobile structured Codex launch', () => {
  it('creates through the structured agent-session intent after support is confirmed', async () => {
    const client = clientReturning({ ok: true, result: { supported: true } }, acceptedCreate)

    await expect(createMobileStructuredCodexSession(client, 'workspace-1')).resolves.toMatchObject({
      kind: 'created',
      sessionId: expect.stringMatching(/^codex_[A-Za-z0-9_]{8,128}$/)
    })
    expect(client.sendRequest).toHaveBeenNthCalledWith(1, 'agentSession.createSupport', {
      worktree: 'id:workspace-1',
      agent: 'codex'
    })
    expect(client.sendRequest).toHaveBeenNthCalledWith(
      2,
      'agentSession.create',
      expect.objectContaining({
        worktree: 'id:workspace-1',
        agent: 'codex',
        envelope: expect.objectContaining({ expectedRuntimeFence: null })
      }),
      expect.objectContaining({ budgetSpansConnect: true })
    )
    const params = client.sendRequest.mock.calls[1]?.[1] as {
      envelope: { sessionId: string; payloadFingerprint: string }
      worktree: string
      agent: 'codex'
    }
    expect(params.envelope.payloadFingerprint).toMatch(/^[0-9a-f]{64}$/)
    expect(params.envelope.sessionId).toMatch(/^codex_[A-Za-z0-9_]{8,128}$/)
  })

  it('reports unsupported without creating a terminal when the structured path is unavailable', async () => {
    const client = clientReturning({ ok: true, result: { supported: false, reason: 'remote' } })

    await expect(createMobileStructuredCodexSession(client, 'workspace-1')).resolves.toEqual({
      kind: 'unsupported',
      reason: 'remote'
    })
    expect(client.sendRequest).toHaveBeenCalledTimes(1)
  })

  it('keeps an unknown create outcome distinct so callers do not create a duplicate terminal', async () => {
    const client = clientReturning({ ok: true, result: { supported: true } })
    client.sendRequest.mockImplementationOnce(async () => ({
      ok: true,
      result: { supported: true }
    }))
    client.sendRequest.mockRejectedValue(markRpcDeliveryUnknown(new Error('response lost')))

    await expect(createMobileStructuredCodexSession(client, 'workspace-1')).resolves.toMatchObject({
      kind: 'unknown'
    })
    expect(client.sendRequest.mock.calls.map(([method]) => method)).toEqual([
      'agentSession.createSupport',
      'agentSession.create',
      'agentSession.create'
    ])
    expect(client.sendRequest.mock.calls[1]?.[1]).toBe(client.sendRequest.mock.calls[2]?.[1])
  })

  it('keeps the outcome unknown when the idempotent retry cannot be sent', async () => {
    const client = clientReturning({ ok: true, result: { supported: true } })
    client.sendRequest.mockImplementationOnce(async () => ({
      ok: true,
      result: { supported: true }
    }))
    client.sendRequest.mockRejectedValueOnce(markRpcDeliveryUnknown(new Error('response lost')))
    client.sendRequest.mockRejectedValueOnce(new Error('connection interrupted'))

    await expect(createMobileStructuredCodexSession(client, 'workspace-1')).resolves.toMatchObject({
      kind: 'unknown'
    })
  })

  it('never creates a legacy sibling after an unclassified create exception', async () => {
    const client = clientReturning({ ok: true, result: { supported: true } })
    client.sendRequest.mockImplementationOnce(async () => ({
      ok: true,
      result: { supported: true }
    }))
    client.sendRequest.mockRejectedValue(new Error('internal error after commit'))

    await expect(createMobileStructuredCodexSession(client, 'workspace-1')).resolves.toMatchObject({
      kind: 'unknown'
    })
    expect(client.sendRequest.mock.calls.map(([method]) => method)).toEqual([
      'agentSession.createSupport',
      'agentSession.create',
      'agentSession.create'
    ])
    expect(client.sendRequest.mock.calls[1]?.[1]).toBe(client.sendRequest.mock.calls[2]?.[1])
  })

  it('treats malformed structured responses as unknown', async () => {
    const client = clientReturning(
      { ok: true, result: { supported: true } },
      { ok: true, result: { ok: true, value: { sessionId: '' } } }
    )

    await expect(createMobileStructuredCodexSession(client, 'workspace-1')).resolves.toMatchObject({
      kind: 'unknown'
    })
  })

  it.each(['structured_agent_session_unsupported', 'method_not_found'])(
    'treats a top-level %s as a definitive refusal',
    async (code) => {
      const client = clientReturning(
        { ok: true, result: { supported: true } },
        { ok: false, error: { code, message: 'structured create unavailable' } }
      )

      await expect(createMobileStructuredCodexSession(client, 'workspace-1')).resolves.toEqual({
        kind: 'failed',
        message: 'structured create unavailable'
      })
    }
  )

  it.each(['agent_session_operation_unknown', 'runtime_error', 'future_unknown_code'])(
    'keeps a top-level %s outcome unknown',
    async (code) => {
      const client = clientReturning(
        { ok: true, result: { supported: true } },
        { ok: false, error: { code, message: 'create outcome ambiguous' } }
      )

      await expect(createMobileStructuredCodexSession(client, 'workspace-1')).resolves.toEqual({
        kind: 'unknown',
        message: 'create outcome ambiguous'
      })
    }
  )

  it('treats an envelope unsupported refusal as definitive', async () => {
    const client = clientReturning(
      { ok: true, result: { supported: true } },
      {
        ok: true,
        result: {
          ok: false,
          refusal: {
            code: 'structured_agent_session_unsupported',
            message: 'structured create unavailable'
          }
        }
      }
    )

    await expect(createMobileStructuredCodexSession(client, 'workspace-1')).resolves.toEqual({
      kind: 'failed',
      message: 'structured create unavailable'
    })
  })

  it.each(['agent_session_operation_unknown', 'agent_session_ownership_unknown', 'future_code'])(
    'keeps an envelope %s refusal unknown',
    async (code) => {
      const client = clientReturning(
        { ok: true, result: { supported: true } },
        {
          ok: true,
          result: {
            ok: false,
            refusal: { code, message: 'create outcome ambiguous' }
          }
        }
      )

      await expect(createMobileStructuredCodexSession(client, 'workspace-1')).resolves.toEqual({
        kind: 'unknown',
        message: 'create outcome ambiguous'
      })
    }
  )
})
