import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it } from 'vitest'
import { stubRpcClient } from '../transport/rpc-client-test-stub'
import type { RpcClient } from '../transport/rpc-client'
import type { RpcResponse } from '../transport/types'
import type { NewChatPermissionSettings } from '../../../src/shared/agent-chat-permission-mode'
import { useMobileNewChatPermission } from './use-mobile-new-chat-permission'

function hostWith(settings: Record<string, unknown> | 'unreachable'): RpcClient {
  return stubRpcClient({
    sendRequest: () =>
      settings === 'unreachable'
        ? Promise.reject(new Error('socket closed'))
        : Promise.resolve<RpcResponse>({
            id: 'reply',
            ok: true,
            result: { settings },
            _meta: { runtimeId: 'runtime' }
          })
  })
}

describe('useMobileNewChatPermission', () => {
  let renderer: ReactTestRenderer | null = null
  let latest: NewChatPermissionSettings | null = null

  function Harness(props: { client: RpcClient; sessionId: string }): null {
    latest = useMobileNewChatPermission(props.client, true, props.sessionId)
    return null
  }

  async function render(client: RpcClient, sessionId = 'chat-1'): Promise<void> {
    await act(async () => {
      const element = createElement(Harness, { client, sessionId })
      if (renderer) {
        renderer.update(element)
      } else {
        renderer = create(element)
      }
    })
  }

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    latest = null
  })

  it("reads the host's new-chat permission and never shows one host's answer for another", async () => {
    await render(hostWith({ agentPermissionDefault: 'full-access' }))
    expect(latest).toEqual({ agentPermissionDefault: 'full-access' })

    await render(hostWith('unreachable'))
    expect(latest).toBeNull()
  })

  it('keeps the last answer when the same host cannot be read for the next chat', async () => {
    let reachable = true
    const client = stubRpcClient({
      sendRequest: () =>
        reachable
          ? Promise.resolve<RpcResponse>({
              id: 'reply',
              ok: true,
              result: { settings: { nativeChatPermissionMode: 'full-access' } },
              _meta: { runtimeId: 'runtime' }
            })
          : Promise.reject(new Error('socket closed'))
    })
    await render(client)
    reachable = false
    await render(client, 'chat-2')
    expect(latest).toEqual({ nativeChatPermissionMode: 'full-access' })
  })
})
