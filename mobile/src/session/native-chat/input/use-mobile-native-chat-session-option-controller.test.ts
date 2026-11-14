// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
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
  let renderer: Root | null = null
  beforeEach(clearNativeChatSessionOptionCacheForTests)
  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
  })

  it('applies a fresh-terminal pick across pending renders and first session metadata, and reports refusal', async () => {
    let tab: Extract<MobileSessionTab, { type: 'terminal' }> = {
      type: 'terminal',
      id: 'claude-tab',
      terminal: 'claude-handle',
      ptyId: 'claude-pty',
      incarnationId: 'claude-incarnation',
      title: 'Claude',
      isActive: true,
      launchAgent: 'claude'
    }
    const readSessionTab = () => tab
    const activeHandleRef = { current: 'claude-handle' }
    const deviceTokenRef = { current: 'phone-device' }
    const dispatchCommand = vi.fn()
    const onSendError = vi.fn()
    const readSeededLaunchDraftSeed = () => null
    const toggleTabChatView = vi.fn()
    let refuse = false
    const controls: unknown[] = []
    const client: RpcClient = {
      sendRequest: async (method, params, options) => {
        options?.beforeSend?.()
        if (method === 'status.get') {
          return { ok: true, id: 'status', result: { capabilities: ['terminal.model-control.v1'] } }
        }
        controls.push(params)
        return {
          ok: true,
          id: 'control',
          result: {
            control: refuse
              ? { outcome: 'blocked', reason: 'admission', agent: 'claude' }
              : { outcome: 'applied' }
          }
        }
      },
      subscribe: () => () => {},
      updateTerminalSubscriptionViewport: () => {},
      getState: () => 'connected',
      getReconnectAttempt: () => 0,
      getLastConnectedAt: () => 1,
      onStateChange: () => () => {},
      notifyForeground: () => {},
      close: () => {}
    }
    let seen: ReturnType<typeof useMobileNativeChatSessionOptionController> | null = null
    function Harness(): null {
      seen = useMobileNativeChatSessionOptionController({
        client,
        activeChatStructured: false,
        activeSessionTab: tab,
        readSessionTab,
        activeHandleRef,
        activeSessionTabId: 'claude-tab',
        agent: 'claude',
        dispatchCommand,
        onSendError,
        hasSeededLaunchDraft: () => readSeededLaunchDraftSeed() !== null,
        deviceTokenRef,
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
      renderer = createRoot(document.createElement('div'))
      renderer.render(createElement(Harness))
    })
    let picked!: Promise<boolean>
    act(() => {
      picked = seen!.nativeChatSessionOptions!.controller.setOption('model', 'opus')
      tab = {
        ...tab,
        agentStatus: {
          agentType: 'claude',
          state: 'waiting',
          prompt: '',
          updatedAt: 1,
          stateStartedAt: 1,
          paneKey: 'pane',
          stateHistory: [],
          providerSession: { key: 'session_id', id: 'first-session' }
        }
      }
      renderer!.render(createElement(Harness))
    })
    await act(async () => {
      expect(await picked).toBe(true)
    })
    expect(controls).toMatchObject([
      {
        terminal: 'claude-handle',
        expectedIncarnationId: 'claude-incarnation',
        client: { id: 'phone-device', type: 'mobile' },
        agent: 'claude',
        intent: { kind: 'set', optionId: 'model', value: 'opus' }
      }
    ])
    expect(seen!.nativeChatSessionOptions!.controller.snapshot[0].kind).toMatchObject({
      currentValue: 'opus'
    })
    refuse = true
    act(() => {
      picked = seen!.nativeChatSessionOptions!.controller.setOption('model', 'haiku')
    })
    await act(async () => {
      expect(await picked).toBe(false)
    })
    expect(onSendError.mock.calls).toHaveLength(1)
    expect(dispatchCommand).not.toHaveBeenCalled()
    expect(seen!.nativeChatSessionOptions!.controller.snapshot[0].kind).toMatchObject({
      currentValue: 'opus'
    })
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
        renderer = createRoot(document.createElement('div'))
        renderer.render(createElement(Harness))
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
