import { afterEach, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import type { RpcResponse } from '../transport/types'
import { openMobileStructuredSession } from './open-mobile-structured-session'

const source = {
  kind: 'history' as const,
  structuredSession: { sessionId: 'old', workspaceId: 'old-workspace' },
  agent: 'codex'
}
const row = { type: 'agent-session', id: 'host-actual', sessionId: 'live', agent: 'codex' }
function rig(existing = false) {
  let rows = existing ? [row] : []
  let generation = 1
  const send = vi.fn<RpcClient['sendRequest']>(async (method): Promise<RpcResponse> => ({
    id: 'reply',
    ok: true,
    result:
      method === 'orchestration.partyLocation'
        ? { location: { kind: 'chat', sessionId: 'live', worktreeId: 'returned-workspace' } }
        : method === 'session.tabs.list'
          ? { tabs: rows }
          : method === 'agentSession.reveal'
            ? ((rows = [row]),
              {
                ok: true,
                sessionId: 'live',
                workspaceId: 'returned-workspace',
                agent: 'codex',
                readable: true
              })
            : {}
  }))
  const client: RpcClient = {
    sendRequest: send,
    subscribe: () => () => {},
    updateTerminalSubscriptionViewport: () => {},
    getState: () => 'connected',
    getGeneration: () => generation,
    getReconnectAttempt: () => 0,
    getLastConnectedAt: () => null,
    onStateChange: () => () => {},
    notifyForeground: () => {},
    close: () => {}
  }
  return {
    send,
    client,
    cutover: () => {
      generation++
    }
  }
}
afterEach(() => vi.useRealTimers())
it('refuses a non-native agent before any host operation', async () => {
  const { client, send } = rig()
  expect(
    await openMobileStructuredSession({
      client,
      source: { ...source, agent: 'invalid agent' },
      current: () => true
    })
  ).toEqual({ kind: 'failed', failure: { reason: 'unsupported', beforeEffects: true } })
  expect(send).not.toHaveBeenCalled()
})
it.each([false, true])(
  'opens using the owning workspace and actual inventory id; existing=%s',
  async (existing) => {
    const { send, client } = rig(existing)
    expect(
      await openMobileStructuredSession({ client, source, current: () => true })
    ).toMatchObject({
      kind: 'opened',
      target: { worktreeId: 'returned-workspace' },
      tab: { id: 'host-actual' }
    })
    expect(send).toHaveBeenLastCalledWith(
      'session.tabs.activate',
      {
        worktree: 'id:returned-workspace',
        tabId: 'host-actual',
        navigation: 'caller',
        notifyClients: false,
        intent: 'user'
      },
      expect.objectContaining({ failWhenDisconnected: true, budgetSpansConnect: true })
    )
    expect(send.mock.calls.filter(([method]) => method === 'agentSession.reveal')).toHaveLength(
      existing ? 0 : 1
    )
    if (!existing) {
      expect(send).toHaveBeenCalledWith(
        'agentSession.reveal',
        { sessionId: 'live', navigation: 'caller' },
        expect.any(Object)
      )
    }
  }
)
it.each(['invalid_argument', 'method_not_found', 'forbidden'])(
  'returns explicit pre-effect old-host %s without an activating retry',
  async (code) => {
    const { client, send } = rig()
    const base = send.getMockImplementation()!
    send.mockImplementation(async (...args) =>
      args[0] === 'agentSession.reveal'
        ? { id: 'old', ok: false, error: { code, message: 'unsupported' } }
        : base(...args)
    )
    expect(
      await openMobileStructuredSession({ client, source, current: () => true })
    ).toMatchObject({ kind: 'failed', failure: { reason: 'unsupported', beforeEffects: true } })
    expect(send.mock.calls.filter(([method]) => method === 'agentSession.reveal')).toHaveLength(1)
    expect(send.mock.calls.some(([method]) => method === 'session.tabs.activate')).toBe(false)
  }
)
it('bounds a lost reveal reply and never authorizes a terminal fallback', async () => {
  vi.useFakeTimers()
  const { client, send } = rig()
  const base = send.getMockImplementation()!
  send.mockImplementation(async (...args) =>
    args[0] === 'agentSession.reveal' ? new Promise(() => {}) : base(...args)
  )
  const result = openMobileStructuredSession({ client, source, current: () => true })
  await vi.advanceTimersByTimeAsync(5_001)
  expect(await result).toMatchObject({
    kind: 'failed',
    failure: { reason: 'unreachable', beforeEffects: false }
  })
  expect(send.mock.calls.filter(([method]) => method === 'agentSession.reveal')).toHaveLength(1)
})
it('drops completion after execution-host/client generation changes', async () => {
  const r = rig()
  const base = r.send.getMockImplementation()!
  r.send.mockImplementation(async (...args) => {
    const reply = await base(...args)
    if (args[0] === 'agentSession.reveal') {
      r.cutover()
    }
    return reply
  })
  expect(
    await openMobileStructuredSession({ client: r.client, source, current: () => true })
  ).toEqual({ kind: 'superseded' })
  expect(r.send.mock.calls.some(([method]) => method === 'session.tabs.activate')).toBe(false)
})
