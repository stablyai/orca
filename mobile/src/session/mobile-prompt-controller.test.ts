import { act } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RpcResponse } from '../transport/types'
import type { RpcClient } from '../transport/rpc-client'
import type { AskPrompt } from '../../../src/shared/native-chat-ask'
import {
  visible,
  handleRef,
  baseTab,
  permissionTab,
  response,
  render,
  reset,
  unmount,
  sendButton,
  permissionAction,
  getController,
  askCancel,
  askAnswer,
  askCollapse,
  sendError,
  getTree
} from './__mocks__/mobile-prompt-controller'

const client: RpcClient = {
  sendRequest: vi.fn<RpcClient['sendRequest']>(),
  subscribe: () => () => {},
  updateTerminalSubscriptionViewport: () => {},
  getState: () => 'connected',
  getReconnectAttempt: () => 0,
  getLastConnectedAt: () => null,
  onStateChange: () => () => {},
  notifyForeground: () => {},
  close: () => {}
}

beforeEach(() => {
  vi.mocked(client.sendRequest).mockReset().mockResolvedValue(response())
  reset(client)
})
afterEach(async () => {
  await unmount()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('prompt cards through the production controller, send contract and view', () => {
  it('finishes an older-host selector once and dismisses it like an acknowledged answer', async () => {
    vi.useFakeTimers()
    const prompt: AskPrompt = {
      questions: [{ question: 'Answer?', options: [{ label: 'A' }], multiSelect: false }]
    }
    const selections = [{ indices: [], other: 'custom answer' }]
    vi.mocked(client.sendRequest).mockResolvedValue(response(true, 'legacy'))
    await render({
      tab: {
        ...baseTab,
        agentStatus: {
          ...baseTab.agentStatus,
          toolName: 'AskUserQuestion',
          interactivePrompt: JSON.stringify(prompt)
        }
      }
    })
    let pending: Promise<boolean> | undefined
    act(() => {
      pending = askAnswer(selections)
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000)
      await expect(pending).resolves.toBe(true)
    })
    const writes = vi
      .mocked(client.sendRequest)
      .mock.calls.filter(([method]) => method === 'terminal.send')
      .map(([, params]) => params)
    expect(writes).toEqual(
      ['2', 'custom answer', '\r'].map((text) =>
        expect.objectContaining({
          text,
          enter: false,
          requireWriteSettlement: true
        })
      )
    )
    expect(getController().nativeChatAsk).toBe(null)
    expect(sendButton().props.disabled).toBe(false)
    expect(sendError).not.toHaveBeenCalled()
  })

  it.each([0, 1])(
    'dismisses older-host approval choice %i like an acknowledged answer and restores Send',
    async (choice) => {
      vi.mocked(client.sendRequest).mockResolvedValue(response(true, 'legacy'))
      await render({ tab: permissionTab })
      await act(async () => {
        await permissionAction(choice).props.onPress()
      })
      expect(getController().nativeChatPermission).toBe(null)
      expect(sendButton().props.disabled).toBe(false)
      expect(sendError).not.toHaveBeenCalled()
      expect(client.sendRequest).toHaveBeenCalledOnce()
    }
  )

  it.each(['refused', 'unverifiable'] as const)(
    'retains permission choices on %s',
    async (mode) => {
      vi.mocked(client.sendRequest).mockResolvedValue(response(false, mode))
      await render({ tab: permissionTab })
      await act(async () => {
        await permissionAction().props.onPress()
      })
      expect(getController().nativeChatPermission).not.toBe(null)
      expect(permissionAction().props.disabled).toBe(false)
      expect(sendButton().props.disabled).toBe(true)
      expect(client.sendRequest).toHaveBeenCalledWith(
        'terminal.send',
        expect.objectContaining({ requireWriteSettlement: true, enter: false, text: '\x1b' }),
        expect.any(Object)
      )
    }
  )

  it.each(['permission', 'ask'])(
    'acknowledges the same pending %s after a view-only toggle',
    async (kind) => {
      const tab =
        kind === 'permission'
          ? permissionTab
          : {
              ...baseTab,
              agentStatus: {
                ...baseTab.agentStatus,
                toolName: 'AskUserQuestion',
                interactivePrompt: JSON.stringify({
                  questions: [
                    {
                      question: 'Pick destination?',
                      options: [{ label: 'East' }, { label: 'West' }]
                    }
                  ]
                })
              }
            }
      let finish: (reply: RpcResponse) => void = () => {
        throw new Error('write not started')
      }
      vi.mocked(client.sendRequest).mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve
          })
      )
      await render({ tab })
      let action: Promise<boolean> | undefined
      act(() => {
        action = kind === 'permission' ? permissionAction().props.onPress() : askCancel()
      })
      visible.value = false
      await render({ tab })
      visible.value = true
      await render({ tab })
      await act(async () => {
        finish(response())
        await action
      })
      expect(getController().nativeChatPermission).toBe(null)
      expect(getController().nativeChatAsk).toBe(null)
      expect(sendButton().props.disabled).toBe(false)
    }
  )

  it('collapses a permission to a strip without writing, and expands it back', async () => {
    await render({ tab: permissionTab })
    act(() => {
      getTree().root.findByProps({ accessibilityLabel: 'Collapse' }).props.onPress()
    })
    expect(getController().nativeChatPermission).not.toBe(null)
    expect(getController().nativeChatCollapsedPrompt?.title).toBeTruthy()
    expect(getTree().root.findAllByProps({ testID: 'native-chat-prompt-strip' })).toHaveLength(1)
    expect(sendButton().props.disabled).toBe(false)
    act(() => {
      getTree().root.findByProps({ accessibilityLabel: 'Expand' }).props.onPress()
    })
    expect(getController().nativeChatPermission).not.toBe(null)
    expect(sendButton().props.disabled).toBe(true)
    expect(client.sendRequest).not.toHaveBeenCalled()
  })

  it('shows a collapsed prompt again as a new wait', async () => {
    await render({ tab: permissionTab })
    act(() => {
      getTree().root.findByProps({ accessibilityLabel: 'Collapse' }).props.onPress()
    })
    await render({
      tab: { ...permissionTab, agentStatus: { ...permissionTab.agentStatus, stateStartedAt: 20 } }
    })
    expect(getController().nativeChatPermission).not.toBe(null)
    expect(getController().nativeChatCollapsedPrompt).toBe(null)
  })

  it('collapses an ask to a strip without writing', async () => {
    await render({
      tab: {
        ...baseTab,
        agentStatus: {
          ...baseTab.agentStatus,
          toolName: 'AskUserQuestion',
          interactivePrompt: JSON.stringify({
            questions: [{ question: 'Pick?', options: [{ label: 'East' }] }]
          })
        }
      }
    })
    act(() => {
      askCollapse()
    })
    expect(getController().nativeChatAsk).not.toBe(null)
    expect(getController().nativeChatCollapsedPrompt?.title).toBe('Pick?')
    expect(sendButton().props.disabled).toBe(false)
    expect(client.sendRequest).not.toHaveBeenCalled()
  })

  it('keeps an acknowledged Deny hidden after the chat screen remounts on a lingering status', async () => {
    await render({ tab: permissionTab })
    await act(async () => {
      await permissionAction().props.onPress()
    })
    expect(sendButton().props.disabled).toBe(false)
    await unmount()
    await render({
      tab: { ...permissionTab, agentStatus: { ...permissionTab.agentStatus, updatedAt: 99 } }
    })
    expect(getController().nativeChatPermission).toBe(null)
    expect(sendButton().props.disabled).toBe(false)
  })

  it.each(['prompt', 'session', 'PTY', 'tab', 'clear'])(
    'drops an accepted result after real %s replacement',
    async (replacement) => {
      let finish: (reply: RpcResponse) => void = () => {
        throw new Error('write not started')
      }
      vi.mocked(client.sendRequest).mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve
          })
      )
      await render({ tab: permissionTab })
      act(() => {
        void permissionAction().props.onPress()
      })
      const agentStatus: NonNullable<typeof permissionTab.agentStatus> = {
        ...permissionTab.agentStatus
      }
      if (replacement === 'prompt') {
        agentStatus.stateStartedAt = 20
      }
      if (replacement === 'session') {
        agentStatus.providerSession = { id: 'session-2', key: 'session_id' }
      }
      if (replacement === 'PTY') {
        handleRef.current = 'term-2'
      }
      if (replacement === 'clear') {
        await render({
          tab: { ...baseTab, agentStatus: { ...baseTab.agentStatus, state: 'working' } }
        })
      }
      await render({
        tab: { ...permissionTab, agentStatus },
        tabId: replacement === 'tab' ? 'tab-2' : 'tab-1'
      })
      await act(async () => {
        finish(response())
      })
      expect(getController().nativeChatPermission).not.toBe(null)
      expect(permissionAction().props.disabled).toBe(false)
      expect(sendButton().props.disabled).toBe(true)
    }
  )
})
