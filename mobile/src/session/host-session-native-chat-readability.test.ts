import { describe, expect, it, vi } from 'vitest'
import type { MobileWebBridgeClient } from '../../../src/mobile-web/src/mobile-web-bridge-client'
import type { RpcClient } from '../transport/rpc-client'
import { resolveMobileNativeChat } from './mobile-native-chat-eligibility'
import { nativeHostSessionNativeChatOperations } from './native-host-session-native-chat-operations'
import { webHostSessionNativeChatOperations } from './web-host-session-native-chat-operations'

const GROK_TAB = { type: 'terminal', launchAgent: 'grok' }

function nativeOperations(connectionId: string | null) {
  const sendRequest = vi.fn().mockResolvedValue({
    ok: true,
    result: { repos: [{ id: 'repo-1', connectionId }] }
  })
  return {
    sendRequest,
    operations: nativeHostSessionNativeChatOperations({ sendRequest } as unknown as RpcClient)
  }
}

describe('native chat transcript readability per host path', () => {
  it('hides a grok tab on the native app when the repo runs on a non-runtime SSH connection', async () => {
    const { operations, sendRequest } = nativeOperations('model-a-ssh')

    const readable = await operations.readability('repo-1::/work/tree')

    expect(readable).toBe(false)
    expect(sendRequest).toHaveBeenCalledWith('repo.list')
    expect(resolveMobileNativeChat(GROK_TAB, readable)).toBeNull()
  })

  it.each([null, 'runtime-ssh-environment'])(
    'shows a grok tab on the native app for a transcript the runtime holds: %s',
    async (connectionId) => {
      const { operations } = nativeOperations(connectionId)

      const readable = await operations.readability('repo-1::/work/tree')

      expect(readable).toBe(true)
      expect(resolveMobileNativeChat(GROK_TAB, readable)).toMatchObject({ agent: 'grok' })
    }
  )

  it('shows the same grok tab on the hosted page without asking the shell', async () => {
    const nativeChat = {}
    const operations = webHostSessionNativeChatOperations({
      nativeChat
    } as unknown as MobileWebBridgeClient)

    const readable = await operations.readability('repo-1::/work/tree')

    expect(readable).toBe(true)
    expect(Object.keys(nativeChat)).toEqual([])
    expect(resolveMobileNativeChat(GROK_TAB, readable)).toMatchObject({ agent: 'grok' })
  })
})
