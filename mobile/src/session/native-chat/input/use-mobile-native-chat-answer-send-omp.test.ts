import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AskPrompt } from '../../../../../src/shared/native-chat/input/native-chat-ask-types'
import type { RpcClient } from '../../../transport/rpc-client'
import { useMobileNativeChatAnswerSend } from './use-mobile-native-chat-answer-send'
import { useNativeChatAcceptedAction } from '../../use-native-chat-action-outcomes'
import {
  isMobileNativeChatInputStale,
  markMobileNativeChatInputStale,
  resetMobileNativeChatStaleInputForTests
} from '../mobile-native-chat-stale-input'
import { resetMobileNativeChatTerminalWritesForTests } from '../mobile-native-chat-terminal-write-lock'

const prompt: AskPrompt = {
  questions: [{ question: 'Pick', multiSelect: true, options: [{ label: 'A' }, { label: 'B' }] }]
}
let renderer: ReactTestRenderer | undefined
beforeEach(() => {
  vi.useFakeTimers()
  resetMobileNativeChatStaleInputForTests()
  resetMobileNativeChatTerminalWritesForTests()
})
afterEach(() => {
  act(() => renderer?.unmount())
  vi.useRealTimers()
})

function mount(agent = 'omp') {
  const sendRequest = vi.fn<RpcClient['sendRequest']>().mockResolvedValue({
    id: 'send',
    ok: true,
    result: { send: { accepted: true } }
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
  const agentRef = { current: agent }
  const onSendError = vi.fn()
  const onAccepted = vi.fn()
  let answer: ReturnType<typeof useMobileNativeChatAnswerSend>['answerAsk'] | undefined
  function Probe(): null {
    const sender = useMobileNativeChatAnswerSend({
      client,
      enabled: true,
      handleRef: { current: 'terminal' },
      deviceTokenRef: { current: 'device' },
      agentRef,
      sessionId: 'session',
      streamIdentity: 'host\0folder\0tab\0session',
      onSendError
    })
    answer = useNativeChatAcceptedAction(sender.answerAsk, onAccepted)
    return null
  }
  act(() => {
    renderer = create(createElement(Probe))
  })
  return {
    sendRequest,
    agentRef,
    onSendError,
    onAccepted,
    answer: () => {
      if (!answer) {
        throw new Error('Answer hook did not mount')
      }
      return answer(prompt, [{ indices: [0, 1] }])
    }
  }
}

describe('OMP terminal-only question answers', () => {
  it('refuses without healing drafts, writing input or dismissing the card', async () => {
    const f = mount()
    markMobileNativeChatInputStale('terminal')
    await expect(f.answer()).resolves.toBe(false)
    expect(f.sendRequest).not.toHaveBeenCalled()
    expect(isMobileNativeChatInputStale('terminal')).toBe(true)
    expect(f.onAccepted).not.toHaveBeenCalled()
    expect(f.onSendError).toHaveBeenCalledWith('Answer this question in terminal view')
  })

  it('refuses a retained answer callback after the live agent becomes OMP', async () => {
    const f = mount('claude')
    f.agentRef.current = 'omp'
    await expect(f.answer()).resolves.toBe(false)
    expect(f.sendRequest).not.toHaveBeenCalled()
    expect(f.onAccepted).not.toHaveBeenCalled()
  })

  it('stops paced writes before another group reaches a replacement OMP agent', async () => {
    const f = mount('claude')
    let sent: Promise<boolean> | undefined
    await act(async () => {
      sent = f.answer()
    })
    expect(f.sendRequest).toHaveBeenCalledTimes(1)
    f.agentRef.current = 'omp'
    await act(async () => {
      await vi.runAllTimersAsync()
    })
    await expect(sent).resolves.toBe(false)
    expect(f.sendRequest).toHaveBeenCalledTimes(1)
    expect(f.onAccepted).not.toHaveBeenCalled()
  })
})
