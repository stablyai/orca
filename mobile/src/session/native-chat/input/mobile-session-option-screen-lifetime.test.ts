import { createElement, StrictMode, useRef } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../../../transport/rpc/rpc-client-contract'
import type { MobileSessionTab } from '../../tabs/mobile-session-tabs'
import { useMobileSessionTabReader } from '../../use-mobile-session-tab-reader'
import { useMobileNativeChatSessionOptionController } from './use-mobile-native-chat-session-option-controller'
import { clearMobileSessionOptionRecordsForTests } from './use-mobile-native-chat-session-options'
import { readNativeChatSessionOptionCache } from '../../../../../src/shared/native-chat/input/native-chat-session-option-cache'
import type { MobileNativeChatSendOutcome } from '../mobile-native-chat-send'

const persist = vi.fn()
vi.mock('./mobile-native-chat-session-option-persistence', () => ({
  writeMobileNativeChatSessionOptions: (...args: unknown[]) => {
    persist(...args)
    return Promise.resolve()
  }
}))
vi.mock('../../use-mobile-native-chat-model-discovery', () => ({
  useMobileNativeChatModelDiscovery: () => null
}))
const client: RpcClient = {
  sendRequest: async () => ({ id: 'request', ok: true, result: null }),
  subscribe: () => () => {},
  updateTerminalSubscriptionViewport: () => {},
  getState: () => 'connected',
  getReconnectAttempt: () => 0,
  getLastConnectedAt: () => null,
  onStateChange: () => () => {},
  notifyForeground: () => {},
  close: () => {}
}
const tab: MobileSessionTab = {
  type: 'terminal',
  id: 'tab',
  title: 'Grok',
  isActive: true,
  terminal: 'handle',
  ptyId: 'pty',
  agentStatus: {
    agentType: 'grok',
    state: 'waiting',
    prompt: '',
    updatedAt: 1,
    stateStartedAt: 1,
    paneKey: 'pane',
    stateHistory: [],
    model: 'grok-4.7',
    providerSession: { key: 'session_id', id: 'session-A' }
  }
}

describe('session option screen lifetime', () => {
  let renderer: ReactTestRenderer | null = null
  let controller: ReturnType<typeof useMobileNativeChatSessionOptionController> | null = null
  const tabs = { current: [tab] }
  beforeEach(() => {
    clearMobileSessionOptionRecordsForTests()
    persist.mockClear()
    tabs.current = [tab]
  })
  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
  })

  it.each([false, true])(
    'retains the accepted session result after screen exit, reopened before acceptance: %s',
    async (reopenBeforeAcceptance) => {
      const toggleTabChatView = vi.fn()
      let accept!: (outcome: MobileNativeChatSendOutcome) => void
      const dispatch = vi.fn(
        () =>
          new Promise<MobileNativeChatSendOutcome>((resolve) => {
            accept = resolve
          })
      )
      function Screen(): null {
        const { readSessionTab } = useMobileSessionTabReader('host', 'worktree', tabs)
        const activeHandleRef = useRef('handle')
        controller = useMobileNativeChatSessionOptionController({
          client,
          activeChatStructured: false,
          activeSessionTabId: 'tab',
          activeSessionTab: tab,
          readSessionTab,
          activeHandleRef,
          agent: 'grok',
          dispatchCommand: dispatch,
          hostId: 'host',
          worktreeId: 'worktree',
          isTabChatView: () => true,
          isWorking: false,
          reportedModel: 'grok-4.7',
          toggleTabChatView,
          structured: { snapshot: [], pendingId: null, setOption: vi.fn(), invokeAction: vi.fn() }
        })
        return null
      }
      act(() => {
        renderer = create(createElement(StrictMode, null, createElement(Screen)))
      })
      dispatch.mockResolvedValueOnce('accepted')
      await act(async () => {
        expect(
          await controller!.nativeChatSessionOptions!.controller.setOption('model', 'grok-4.7-fast')
        ).toBe(true)
      })
      let picked!: Promise<boolean>
      await act(async () => {
        picked = controller!.nativeChatSessionOptions!.controller.setOption('model', 'grok-4.7')
        await Promise.resolve()
      })
      expect(dispatch).toHaveBeenCalledTimes(2)
      act(() => renderer!.unmount())
      renderer = null
      const reopen = () =>
        act(() => {
          renderer = create(createElement(StrictMode, null, createElement(Screen)))
        })
      if (reopenBeforeAcceptance) {
        reopen()
      }
      await act(async () => {
        accept('accepted')
        await expect(picked).resolves.toBe(true)
      })
      expect(tabs.current).toEqual([tab])
      expect(persist).toHaveBeenCalledWith(
        client,
        expect.objectContaining({
          agent: 'grok',
          picks: [expect.objectContaining({ modelId: 'grok-4.7' })]
        })
      )
      expect(readNativeChatSessionOptionCache('host\0worktree\0tab')?.model?.value).toBe('grok-4.7')
      if (!reopenBeforeAcceptance) {
        reopen()
      }
      expect(toggleTabChatView).not.toHaveBeenCalled()
      expect(controller!.nativeChatSessionOptions!.controller.snapshot[0].kind).toMatchObject({
        currentValue: 'grok-4.7'
      })
    }
  )
})
