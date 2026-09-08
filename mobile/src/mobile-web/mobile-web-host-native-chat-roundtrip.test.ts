import { describe, expect, it, vi } from 'vitest'
import { nativeChatBridgeFixture as fixture } from './mobile-web-host-native-chat-test-fixture'

describe('native-chat generic read migration', () => {
  it('reads native chat through the generic host lane', async () => {
    const f = fixture()
    const workspaceId = (await f.client.workspaceSnapshot({ limit: 10 })).workspaces[0]!.id
    const session = await f.client.sessionSnapshot({ workspaceId })
    const tab = session.tabs.find((tab) => tab.type === 'terminal')!
    if (tab.type !== 'terminal' || !tab.nativeChatSessionId) {
      throw new Error('Missing chat fixture')
    }
    const result = await f.client.nativeChat.readForTab(
      { workspaceId, sessionId: tab.nativeChatSessionId, limit: 20 },
      tab.id
    )
    expect(result.messages[0].blocks[0]).toMatchObject({ type: 'text', text: 'hello' })
    expect(result).toEqual(f.transcript)
    expect(f.sendRequest).toHaveBeenCalledWith(
      'mobileWeb.nativeChat.read',
      {
        worktree: 'id:host-workspace',
        tabId: 'tab',
        sessionId: 'provider-session',
        read: { limit: 20 }
      },
      expect.objectContaining({ beforeSend: expect.any(Function) })
    )
    expect(f.sendRequest.mock.calls.some(([method]) => method === 'nativeChat.readSession')).toBe(
      false
    )
    expect(JSON.stringify(f.shellMessages)).not.toContain('private-terminal')
  })
  it('streams native chat through the generic host lane', async () => {
    const f = fixture()
    const workspaceId = (await f.client.workspaceSnapshot({ limit: 10 })).workspaces[0]!.id
    const session = await f.client.sessionSnapshot({ workspaceId })
    const tab = session.tabs[0]
    if (tab.type !== 'terminal' || !tab.nativeChatSessionId) {
      throw new Error('Missing chat fixture')
    }
    const onEvent = vi.fn()
    const subscription = f.client.nativeChat.subscribeForTab(
      tab.id,
      { workspaceId, sessionId: tab.nativeChatSessionId, limit: 20 },
      onEvent,
      vi.fn()
    )
    await subscription.ready
    expect(f.subscribe.mock.calls[0][0]).toBe('mobileWeb.nativeChat.subscribe')
    const event = { type: 'snapshot', ...f.transcript }
    f.emit(event)
    await vi.waitFor(() => expect(onEvent).toHaveBeenCalledOnce())
    expect(onEvent).toHaveBeenCalledWith(event)
    expect(f.subscribe.mock.calls[0][1]).toMatchObject({
      tabId: 'tab',
      sessionId: 'provider-session'
    })
    subscription.unsubscribe()
    expect(f.unsubscribe).toHaveBeenCalledOnce()
  })
  it('releases the host feed when the page cancels before it is ready', async () => {
    const f = fixture()
    const workspaceId = (await f.client.workspaceSnapshot({ limit: 10 })).workspaces[0]!.id
    const session = await f.client.sessionSnapshot({ workspaceId })
    const tab = session.tabs[0]
    if (tab.type !== 'terminal' || !tab.nativeChatSessionId) {
      throw new Error('Missing chat fixture')
    }
    const onError = vi.fn()
    const subscription = f.client.nativeChat.subscribeForTab(
      tab.id,
      { workspaceId, sessionId: tab.nativeChatSessionId, limit: 20 },
      vi.fn(),
      onError
    )
    subscription.unsubscribe()
    await expect(subscription.ready).rejects.toMatchObject({ code: 'cancelled' })
    await vi.waitFor(() => expect(f.unsubscribe).toHaveBeenCalledOnce())
    expect(onError).not.toHaveBeenCalled()
  })
})
