import { expect, it } from 'vitest'
import { openMobileStructuredSession } from './open-mobile-structured-session'
import type { RpcClient } from '../../../transport/rpc/rpc-client-contract'
import type { RpcResponse } from '../../../transport/rpc/rpc-wire-types'

const RESET = { code: 'remote_runtime_unavailable', message: 'The server connection was reset.' }
const botLinkTarget = {
  botId: 'bot',
  conversation: { source: 'slack' as const, externalId: 'C:1' },
  leadSessionId: 'lead',
  sessionId: 'lead',
  worktreeId: 'folder-1'
}

function host(refusals: Record<string, { code: string; message: string }>) {
  const sent: string[] = []
  let revealed = false
  const results: Record<string, () => unknown> = {
    'orchestration.partyLocation': () => ({
      location: { kind: 'chat', sessionId: 'lead', worktreeId: 'folder-1' }
    }),
    'session.tabs.list': () => ({
      tabs: revealed
        ? [{ type: 'agent-session', id: 'tab-1', sessionId: 'lead', agent: 'claude' }]
        : []
    }),
    'agentSession.reveal': () => {
      revealed = true
      return {
        ok: true,
        sessionId: 'lead',
        workspaceId: 'folder-1',
        agent: 'claude',
        readable: true
      }
    },
    'session.tabs.activate': () => ({})
  }
  const partial: Pick<
    RpcClient,
    'getState' | 'getGeneration' | 'getLastConnectedAt' | 'onStateChange' | 'sendRequest'
  > = {
    getState: () => 'connected',
    getGeneration: () => 1,
    getLastConnectedAt: () => 2,
    onStateChange: () => () => {},
    sendRequest: async (method): Promise<RpcResponse> => {
      sent.push(method)
      const refusal = refusals[method]
      return refusal
        ? { id: 'r', ok: false, error: refusal }
        : { id: 'r', ok: true, result: results[method]?.() ?? {} }
    }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: opening reads only requests and connection state from this fixture.
  return { client: partial as RpcClient, sent }
}

function open(client: RpcClient) {
  return openMobileStructuredSession({
    botLinkTarget,
    client,
    current: () => true,
    source: { kind: 'notification', sessionId: 'lead', worktreeId: 'folder-1' }
  })
}

it('stops a bot link open whose server connection resets during the inventory refresh', async () => {
  const { client, sent } = host({ 'session.tabs.list': RESET })
  expect((await open(client)).kind).not.toBe('opened')
  expect(sent).not.toContain('agentSession.reveal')
  expect(sent).not.toContain('session.tabs.activate')
})

it('still repairs through reveal after an ordinary inventory refusal (control)', async () => {
  const { client, sent } = host({ 'session.tabs.list': { code: 'failed', message: 'busy' } })
  await open(client)
  expect(sent).toContain('agentSession.reveal')
})

it.each(['orchestration.partyLocation', 'session.tabs.activate', 'agentSession.reveal'])(
  'fails a bot link open whose server connection resets during %s (control)',
  async (method) => {
    const { client } = host({ [method]: RESET })
    expect((await open(client)).kind).not.toBe('opened')
  }
)

it('opens the chat when the server answers (control)', async () => {
  const { client } = host({})
  expect((await open(client)).kind).toBe('opened')
})
