import { describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import { createMobileWebBridgeRoundtripFixture } from './mobile-web-bridge-roundtrip-fixture'
import { MOBILE_WEB_PRODUCTION_GRANTS } from './mobile-web-production-grants'

function fixture() {
  let emit: (event: unknown) => void = () => {}
  const unsubscribe = vi.fn()
  const subscribe = vi.fn<RpcClient['subscribe']>((_method, _params, listener) => {
    emit = listener
    return unsubscribe
  })
  const sendRequest = vi.fn<RpcClient['sendRequest']>().mockResolvedValue({
    ok: true,
    result: {
      worktrees: [{ worktreeId: 'host-workspace', repo: '/private/repo', displayName: 'Workspace' }]
    }
  })
  const bridge = createMobileWebBridgeRoundtripFixture({
    grants: MOBILE_WEB_PRODUCTION_GRANTS,
    rpcClient: { sendRequest, subscribe } as unknown as RpcClient
  })
  return { ...bridge, subscribe, unsubscribe, emit: (event: unknown) => emit(event) }
}

describe('generic subscription bridge compatibility', () => {
  it('subscribes to source control through the generic shell lane', async () => {
    const f = fixture()
    const workspace = (await f.client.workspaceSnapshot({ limit: 10 })).workspaces[0]!.id
    const onEvent = vi.fn()
    const onError = vi.fn()
    const subscription = f.client.sourceControlSubscribe(
      { workspaceId: workspace },
      onEvent,
      onError
    )
    await subscription.ready
    expect(f.subscribe.mock.calls[0]?.[0]).toBe('mobileWeb.files.watch')
    f.emit({
      type: 'changed',
      events: [],
      futureField: 'new'
    })
    await vi.waitFor(() =>
      expect(onEvent).toHaveBeenCalledWith({ workspaceId: workspace, reason: 'changed' })
    )
    expect(onError).not.toHaveBeenCalled()
    subscription.unsubscribe()
    expect(f.unsubscribe).toHaveBeenCalledOnce()
  })

  it('forwards a future method and event without adding a domain operation', async () => {
    const f = fixture()
    const workspaceId = (await f.client.workspaceSnapshot({ limit: 10 })).workspaces[0]!.id
    const onEvent = vi.fn()
    const subscription = f.client.hostSubscribe(
      { method: 'future.feed.subscribe', workspaceId, params: { newParam: 42 } },
      onEvent,
      vi.fn()
    )
    await subscription.ready
    const event = { futureKind: 'unknown-to-shell', fields: { addedLater: true } }
    f.emit(event)
    await vi.waitFor(() => expect(onEvent).toHaveBeenCalledWith(event))
    expect(f.subscribe).toHaveBeenCalledWith(
      'future.feed.subscribe',
      { worktree: 'id:host-workspace', newParam: 42 },
      expect.any(Function),
      { serverUnsubscribeMethod: 'future.feed.unsubscribe' }
    )
    subscription.unsubscribe()
  })
})
