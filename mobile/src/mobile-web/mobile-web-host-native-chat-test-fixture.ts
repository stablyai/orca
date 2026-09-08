import { vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import { createMobileWebBridgeRoundtripFixture } from './mobile-web-bridge-roundtrip-fixture'
import { MOBILE_WEB_PRODUCTION_GRANTS } from './mobile-web-production-grants'

export function nativeChatBridgeFixture() {
  const transcript = {
    messages: [
      {
        id: 'm',
        role: 'assistant',
        source: 'transcript',
        timestamp: null,
        blocks: [{ type: 'text', text: 'hello', futureFormatting: 'rich' }],
        futureProviderField: { revision: 2 }
      }
    ],
    hasMore: false,
    futureLifecycle: 'new'
  }
  const sendRequest = vi.fn<RpcClient['sendRequest']>(async (method, params) => {
    if (method === 'worktree.ps') {
      return {
        id: 'test-request',
        _meta: { runtimeId: 'test-runtime' },
        ok: true,
        result: {
          worktrees: [
            { worktreeId: 'host-workspace', repo: '/private/repo', displayName: 'Workspace' }
          ]
        }
      }
    }
    if (method === 'session.tabs.list') {
      return {
        id: 'test-request',
        _meta: { runtimeId: 'test-runtime' },
        ok: true,
        result: {
          worktree: 'host-workspace',
          publicationEpoch: 'epoch',
          snapshotVersion: 1,
          activeTabId: 'tab',
          activeTabType: 'terminal',
          tabs: [
            {
              id: 'tab',
              type: 'terminal',
              terminal: 'private-terminal',
              title: 'Chat',
              isActive: true,
              agentStatus: { agentType: 'codex', providerSession: { id: 'provider-session' } }
            }
          ]
        }
      }
    }
    if (method === 'mobileWeb.nativeChat.mutate') {
      const input = params as { action: string }
      return {
        id: 'test-request',
        _meta: { runtimeId: 'test-runtime' },
        ok: true,
        result:
          input.action === 'prepareCommit'
            ? { prepared: true }
            : {
                outcome: 'accepted',
                futureReceipt: { revision: 2 }
              }
      }
    }
    if (method === 'terminal.send') {
      return {
        id: 'test-request',
        _meta: { runtimeId: 'test-runtime' },
        ok: true,
        result: { send: { accepted: true } }
      }
    }
    return {
      id: 'test-request',
      _meta: { runtimeId: 'test-runtime' },
      ok: true,
      result: transcript
    }
  })
  let emit: (event: unknown) => void = () => {}
  const unsubscribe = vi.fn()
  const subscribe = vi.fn<RpcClient['subscribe']>((_method, _params, listener) => {
    emit = listener
    return unsubscribe
  })
  const bridge = createMobileWebBridgeRoundtripFixture({
    grants: MOBILE_WEB_PRODUCTION_GRANTS,
    rpcClient: { sendRequest, subscribe } as unknown as RpcClient
  })
  return {
    ...bridge,
    sendRequest,
    transcript,
    subscribe,
    unsubscribe,
    emit: (event: unknown) => emit(event)
  }
}
