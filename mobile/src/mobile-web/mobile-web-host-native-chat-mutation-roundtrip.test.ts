import { afterEach, describe, expect, it, vi } from 'vitest'
import { nativeChatBridgeFixture } from './mobile-web-host-native-chat-test-fixture'

afterEach(() => vi.restoreAllMocks())

async function fixture() {
  const f = nativeChatBridgeFixture()
  const workspaceId = (await f.client.workspaceSnapshot({ limit: 10 })).workspaces[0]!.id
  const snapshot = await f.client.sessionSnapshot({ workspaceId })
  const tab = snapshot.tabs.find((tab) => tab.type === 'terminal')!
  if (tab.type !== 'terminal' || !tab.nativeChatSessionId) {
    throw new Error('Missing chat tab')
  }
  return {
    ...f,
    tabId: tab.id,
    payload: { workspaceId, sessionId: tab.nativeChatSessionId, deadline: Date.now() + 15_000 }
  }
}
describe('generic native-chat actions', () => {
  it('uses the generic mutate lane instead of terminal.send', async () => {
    const f = await fixture()
    const result = await f.client.nativeChat.sendMessage(
      { ...f.payload, text: 'hello' },
      undefined,
      f.tabId
    )
    expect(result.outcome).toBe('accepted')
    expect(
      f.sendRequest.mock.calls.filter(([name]) => name === 'mobileWeb.nativeChat.mutate')
    ).toHaveLength(1)
    expect(f.sendRequest.mock.calls.filter(([name]) => name === 'terminal.send')).toHaveLength(0)
    expect(result).toMatchObject({ futureReceipt: { revision: 2 } })
    const [, params] = f.sendRequest.mock.calls.find(
      ([name]) => name === 'mobileWeb.nativeChat.mutate'
    )!
    expect(params).toMatchObject({
      action: 'sendMessage',
      text: 'hello',
      tabId: 'tab',
      sessionId: 'provider-session'
    })
    expect(params).not.toHaveProperty('deadline')
    f.client.dispose()
  })
  it.each(['respond', 'stop', 'prepareCommit'] as const)(
    'forwards %s through the generic lane',
    async (action) => {
      const f = await fixture()
      const result =
        action === 'respond'
          ? await f.client.nativeChat.respond(
              { ...f.payload, text: '1', enter: false },
              undefined,
              f.tabId
            )
          : await f.client.nativeChat[action](f.payload, undefined, f.tabId)
      expect(result).toEqual(
        action === 'prepareCommit'
          ? { prepared: true }
          : { outcome: 'accepted', futureReceipt: { revision: 2 } }
      )
      expect(f.sendRequest.mock.calls.some(([name]) => name === 'terminal.send')).toBe(false)
      f.client.dispose()
    }
  )
  it.each(['runtime_error', 'method_not_found'])(
    'never repeats a mutation after %s',
    async (code) => {
      const f = await fixture()
      const original = f.sendRequest.getMockImplementation()!
      f.sendRequest.mockImplementation((...args) =>
        args[0] === 'mobileWeb.nativeChat.mutate'
          ? Promise.resolve({ ok: false, error: { code, message: 'failed' } })
          : original(...args)
      )
      const result = await f.client.nativeChat.sendMessage(
        { ...f.payload, text: 'hello' },
        undefined,
        f.tabId
      )
      expect(result.outcome).toBe(code === 'runtime_error' ? 'unknown' : 'rejected')
      expect(
        f.sendRequest.mock.calls.filter(([name]) => name === 'mobileWeb.nativeChat.mutate')
      ).toHaveLength(1)
      expect(f.sendRequest.mock.calls.some(([name]) => name === 'terminal.send')).toBe(false)
      f.client.dispose()
    }
  )
  it('does not start a mutation whose budget is already spent', async () => {
    const f = await fixture()
    vi.spyOn(Date, 'now').mockReturnValue(f.payload.deadline)
    expect(await f.client.nativeChat.stop(f.payload, undefined, f.tabId)).toEqual({
      outcome: 'rejected'
    })
    expect(f.sendRequest.mock.calls.some(([name]) => name === 'mobileWeb.nativeChat.mutate')).toBe(
      false
    )
    f.client.dispose()
  })
})
