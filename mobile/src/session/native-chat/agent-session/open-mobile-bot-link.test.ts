import { expect, it } from 'vitest'
import type { RpcResponse } from '../../../transport/rpc/rpc-wire-types'
import { openMobileStructuredSession } from './open-mobile-structured-session'
import type { RpcClient } from '../../../transport/rpc/rpc-client-contract'
import type { BotLinkOpenTarget } from '../../../../../src/shared/bots/bot-link-open-target'

it('refuses a clear successor returned after the exact item was authorized', async () => {
  let selected = 'another-chat'
  const guard: BotLinkOpenTarget = {
    botId: 'bot',
    conversation: { source: 'slack', externalId: 'C1:123' },
    leadSessionId: 'A',
    sessionId: 'A',
    worktreeId: 'workspace',
    itemId: 'question-A'
  }
  const partial: Pick<RpcClient, 'getState' | 'getGeneration' | 'onStateChange' | 'sendRequest'> = {
    getState: () => 'connected',
    getGeneration: () => 1,
    onStateChange: () => () => {},
    sendRequest: async (method) => {
      if (method === 'orchestration.partyLocation') {
        return {
          id: 'r',
          ok: true,
          result: { location: { kind: 'chat', sessionId: 'B', worktreeId: 'workspace' } }
        }
      }
      if (method === 'session.tabs.activate' || method === 'agentSession.reveal') {
        selected = 'B'
      }
      return { id: 'r', ok: true, result: {} }
    }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this opener only uses these three RPC client methods.
  const client = partial as RpcClient
  const opened = await openMobileStructuredSession({
    client,
    current: () => true,
    botLinkTarget: guard,
    source: { kind: 'notification', sessionId: 'A', worktreeId: 'workspace' },
    inventory: { worktreeId: 'workspace', tabs: [{ id: 'tab-B', sessionId: 'B', agent: 'codex' }] }
  })
  expect(opened).toMatchObject({ kind: 'failed', failure: { reason: 'gone', beforeEffects: true } })
  expect(selected).toBe('another-chat')
})

it('settles a cancelled opening and never publishes after the pending location eventually answers', async () => {
  let release!: (reply: RpcResponse) => void
  const pending = new Promise<RpcResponse>((resolve) => {
    release = resolve
  })
  let published = false
  const partial: Pick<RpcClient, 'getState' | 'getGeneration' | 'onStateChange' | 'sendRequest'> = {
    getState: () => 'connected',
    getGeneration: () => 1,
    onStateChange: () => () => {},
    sendRequest: async (method) => {
      if (method === 'orchestration.partyLocation') {
        return pending
      }
      published = true
      return { id: 'r', ok: true, result: {} }
    }
  }
  const abort = new AbortController()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the opener reads only RPC and connection observation from this fixture.
  const client = partial as RpcClient
  const opening = openMobileStructuredSession({
    client,
    signal: abort.signal,
    current: () => true,
    source: { kind: 'notification', sessionId: 'A', worktreeId: 'workspace' }
  })
  abort.abort()
  expect(await opening).toEqual({ kind: 'superseded' })
  release({
    id: 'location',
    ok: true,
    result: { location: { kind: 'chat', sessionId: 'A', worktreeId: 'workspace' } }
  })
  await pending
  expect(published).toBe(false)
})
