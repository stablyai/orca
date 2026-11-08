import { act } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import './native-chat/input/mobile-native-chat-prompt-dismissals'
import './mobile-structured-send-delivery'
import './structured-agent-send-result.test-fixture'
import type { RpcResponse } from '../transport/rpc/rpc-wire-types'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import type { NativeChatMessage } from '../../../src/shared/native-chat/native-chat-types'

import {
  session,
  structuredSession,
  baseTab,
  permissionTab,
  response,
  render,
  reset,
  unmount,
  sendButton,
  permissionAction,
  getController,
  askAnswer,
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
})

vi.mock('./MobileQueuedMessageComposer', () => ({
  MobileQueuedMessageComposer: 'QueuedMessageComposer'
}))

describe('async occurrences through the phone controller and rendered card actions', () => {
  const row = (id: string, title = 'Q1?', callId?: string): NativeChatMessage => ({
    id,
    role: 'assistant',
    timestamp: null,
    source: 'transcript',
    blocks: [
      {
        type: 'tool-call',
        name: 'request_user_input_async',
        callId,
        input: { questions: [{ title, options: ['Red', 'Blue'] }] }
      }
    ]
  })
  const structuredTab = {
    type: 'agent-session',
    id: 'tab-1',
    title: 'Chat',
    sessionId: 'session-1',
    agent: 'codex',
    isActive: true
  }
  const terminalTab = {
    ...baseTab,
    launchAgent: 'codex',
    agentStatus: { ...baseTab.agentStatus, agentType: 'codex' }
  }
  const titles = () => getController().nativeChatAsk?.questions.map((q) => q.question)

  it('settles the terminal answer for Q1 after Q2 arrives without hiding Q2', async () => {
    let finish: (reply: RpcResponse) => void = () => {
      throw new Error('not sent')
    }
    vi.mocked(client.sendRequest).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    const q1 = row('one')
    session.messages = [q1]
    await render({ tab: terminalTab })
    let answer: Promise<boolean> | undefined
    await act(async () => {
      answer = askAnswer([{ indices: [1] }])
    })
    session.messages = [q1, row('two', 'Q2?')]
    await render({ tab: terminalTab })
    await act(async () => {
      finish(response())
      await answer
    })
    expect(titles()).toEqual(['Q2?'])
  })

  it('keeps structured answer controls after a thrown send', async () => {
    structuredSession.sendWithOutcome.mockRejectedValue(new Error('send failed'))
    session.messages = [row('one')]
    await render({ tab: structuredTab })
    await act(async () => {
      await expect(askAnswer([{ indices: [1] }])).rejects.toThrow('send failed')
    })
    expect(titles()).toEqual(['Q1?'])
  })
})
