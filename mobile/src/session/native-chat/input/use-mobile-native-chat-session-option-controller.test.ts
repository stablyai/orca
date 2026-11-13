import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearNativeChatSessionOptionCacheForTests } from '../../../../../src/shared/native-chat/input/native-chat-session-option-cache'
import type { RpcClient } from '../../../transport/rpc/rpc-client-contract'
import type { MobileSessionTab } from '../../tabs/mobile-session-tabs'
import { useMobileNativeChatSessionOptionController } from './use-mobile-native-chat-session-option-controller'

vi.mock('./use-mobile-native-chat-model-discovery', () => ({
  useMobileNativeChatModelDiscovery: () => null
}))
vi.mock('./mobile-native-chat-session-option-persistence', () => ({
  writeMobileNativeChatSessionOptions: vi.fn()
}))

describe('useMobileNativeChatSessionOptionController on a structured chat', () => {
  let renderer: ReactTestRenderer | null = null
  beforeEach(clearNativeChatSessionOptionCacheForTests)
  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
  })

  it.each([false, true])(
    'keeps a capable blocked model pick away from message send and healing with late handle=%s',
    async (lateHandle) => {
      const dispatchCommand = vi.fn()
      const toggleTabChatView = vi.fn()
      const onSendError = vi.fn()
      const sendRequest = vi
        .fn<RpcClient['sendRequest']>()
        .mockImplementation(async (method, _params, options) => {
          options?.beforeSend?.()
          return {
            ok: true,
            id: 'reply',
            result:
              method === 'status.get'
                ? { capabilities: ['terminal.model-control.v1'] }
                : { control: { outcome: 'blocked', reason: 'foreign-draft', agent: 'codex' } }
          }
        })
      const client: RpcClient = {
        sendRequest,
        subscribe: () => () => {},
        updateTerminalSubscriptionViewport: () => {},
        getState: () => 'connected',
        getReconnectAttempt: () => 0,
        getLastConnectedAt: () => 1,
        onStateChange: () => () => {},
        notifyForeground: () => {},
        close: () => {}
      }
      const tab: MobileSessionTab = {
        type: 'terminal',
        id: 'codex-tab',
        terminal: 'handle',
        ptyId: 'pty',
        title: 'Codex',
        isActive: true,
        launchAgent: 'codex'
      }
      const seen: {
        current: ReturnType<typeof useMobileNativeChatSessionOptionController> | null
      } = { current: null }
      function Harness(): null {
        seen.current = useMobileNativeChatSessionOptionController({
          client,
          activeChatStructured: false,
          activeSessionTab: lateHandle ? { ...tab, terminal: undefined } : tab,
          readSessionTab: () => tab,
          activeHandleRef: { current: 'handle' },
          activeSessionTabId: 'codex-tab',
          agent: 'codex',
          dispatchCommand,
          onSendError,
          deviceTokenRef: { current: 'device' },
          terminalInputEnabled: true,
          hostId: 'host',
          isTabChatView: () => true,
          isWorking: false,
          reportedModel: null,
          structured: { snapshot: [], pendingId: null, setOption: vi.fn(), invokeAction: vi.fn() },
          toggleTabChatView,
          worktreeId: 'worktree'
        })
        return null
      }
      act(() => {
        renderer = create(createElement(Harness))
      })
      await act(async () => {
        expect(await seen.current!.nativeChatSessionOptions!.controller.invokeAction('model')).toBe(
          false
        )
      })
      expect(sendRequest.mock.calls.map(([method]) => method)).toEqual([
        'status.get',
        'terminal.model-control'
      ])
      expect(dispatchCommand).not.toHaveBeenCalled()
      expect(toggleTabChatView).not.toHaveBeenCalled()
      expect(onSendError).toHaveBeenCalledExactlyOnceWith(
        "Codex can't change options from Chat in this session."
      )
    }
  )
})
