import { expect, it, vi } from 'vitest'
import { CreateIntentParams } from '../../../src/shared/rpc-contract/structured-agent-session-params'
import { createFakeRpcClient, rpcSuccess } from '../mobile-web-shell/bridge-host-test-fakes'
import { createMobileStructuredAgentSession } from './mobile-structured-agent-session-launch'

it('opens explicit side chats even when the legacy launch-mode probe refuses Chat by default', async () => {
  const client = createFakeRpcClient()
  const send = vi.spyOn(client, 'sendRequest').mockImplementation(async (method, raw) => {
    if (method === 'agentSession.createSupport') {
      return {
        id: 'probe',
        ok: false,
        error: { code: 'structured_agent_session_unsupported', message: 'Chat is not the default.' }
      }
    }
    const params = CreateIntentParams.parse(raw)
    return rpcSuccess('create', {
      ok: true,
      value: { sessionId: params.envelope.sessionId }
    })
  })
  await expect(
    createMobileStructuredAgentSession(client, 'folder-1', 'codex', 'codex_parent_123')
  ).resolves.toEqual({ kind: 'created', sessionId: expect.any(String) })
  expect(send).toHaveBeenCalledOnce()
  expect(send.mock.calls[0]?.[0]).toBe('agentSession.create')
})

it('keeps the read-only permission in its durable create payload', async () => {
  const client = createFakeRpcClient()
  const send = vi.spyOn(client, 'sendRequest').mockImplementation(async (_method, raw) => {
    const params = CreateIntentParams.parse(raw)
    expect(params.options).toEqual({ permissionMode: 'read-only' })
    return rpcSuccess('create', { ok: true, value: { sessionId: params.envelope.sessionId } })
  })
  await expect(
    createMobileStructuredAgentSession(
      client,
      'folder-1',
      'codex',
      'codex_parent_123',
      '',
      [],
      'read-only'
    )
  ).resolves.toEqual({ kind: 'created', sessionId: expect.any(String) })
  expect(send).toHaveBeenCalledOnce()
})
