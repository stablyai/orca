import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentType } from '../../../src/shared/native-chat-types'
import type { RpcClient } from '../transport/rpc-client'
import { MOBILE_NATIVE_CHAT_QUESTION_STEP_MS } from './mobile-native-chat-answer-stepping'
import type { AskPrompt } from './mobile-native-chat-ask'
import { useMobileNativeChatAnswerSend } from './use-mobile-native-chat-answer-send'

type AnswerSend = ReturnType<typeof useMobileNativeChatAnswerSend>

function acceptedResponse() {
  return {
    id: 'send',
    ok: true as const,
    result: { send: { accepted: true } },
    _meta: { runtimeId: 'runtime' }
  }
}

const TABS_OR_SPACES: AskPrompt = {
  questions: [
    {
      question: 'Tabs or spaces?',
      multiSelect: false,
      options: [{ label: 'Tabs' }, { label: 'Spaces' }]
    }
  ]
}

describe('useMobileNativeChatAnswerSend', () => {
  let renderer: ReactTestRenderer | null = null
  let answerSend: AnswerSend | null = null
  let mountedClient: RpcClient | null = null
  let mountedOnSendError: ((message: string) => void) | null = null
  let mountedAgent: AgentType = 'claude'

  beforeEach(() => {
    vi.useFakeTimers()
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
  })

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    answerSend = null
    mountedClient = null
    mountedOnSendError = null
    mountedAgent = 'claude'
    vi.useRealTimers()
  })

  function Harness({ enabled }: { enabled: boolean }): null {
    answerSend = useMobileNativeChatAnswerSend({
      client: mountedClient,
      enabled,
      handleRef: { current: 'terminal' },
      deviceTokenRef: { current: 'device' },
      agentRef: { current: mountedAgent },
      sessionId: 'session',
      streamIdentity: 'host\0worktree\0tab\0session',
      onSendError: mountedOnSendError!
    })
    return null
  }

  async function mount(
    client: RpcClient,
    onSendError: (message: string) => void,
    agent: AgentType = 'claude'
  ): Promise<void> {
    mountedClient = client
    mountedOnSendError = onSendError
    mountedAgent = agent
    const original = console.error
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation((...args) => {
      if (typeof args[0] === 'string' && args[0].includes('react-test-renderer is deprecated')) {
        return
      }
      original(...args)
    })
    try {
      await act(async () => {
        renderer = create(createElement(Harness, { enabled: true }))
      })
    } finally {
      consoleSpy.mockRestore()
    }
  }

  async function setEnabled(enabled: boolean): Promise<void> {
    await act(async () => {
      renderer?.update(createElement(Harness, { enabled }))
    })
  }

  it('single-select: sends the picked option NUMBER (not the label), no trailing Enter', async () => {
    const sendRequest = vi.fn().mockResolvedValue(acceptedResponse())
    await mount({ sendRequest } as unknown as RpcClient, vi.fn())

    // Spaces is option 2 — the STA-1860 case where label text committed Tabs.
    await expect(answerSend?.answerAsk(TABS_OR_SPACES, [{ indices: [1] }])).resolves.toBe(true)
    expect(sendRequest).toHaveBeenCalledTimes(1)
    expect(sendRequest.mock.calls[0]?.[1]).toMatchObject({ text: '2', enter: false })
  })

  it('multi-select: toggles each option number, steps to Submit, confirms — paced apart', async () => {
    const sendRequest = vi.fn().mockResolvedValue(acceptedResponse())
    await mount({ sendRequest } as unknown as RpcClient, vi.fn())

    const prompt: AskPrompt = {
      questions: [
        {
          question: 'Pick fruits',
          multiSelect: true,
          options: [{ label: 'Apple' }, { label: 'Banana' }, { label: 'Cherry' }]
        }
      ]
    }
    let result: Promise<boolean> | undefined
    await act(async () => {
      result = answerSend?.answerAsk(prompt, [{ indices: [0, 2] }])
    })
    expect(sendRequest).toHaveBeenCalledTimes(1)
    expect(sendRequest.mock.calls[0]?.[1]).toMatchObject({ text: '1', enter: false })

    await act(async () => vi.advanceTimersByTimeAsync(MOBILE_NATIVE_CHAT_QUESTION_STEP_MS))
    expect(sendRequest.mock.calls[1]?.[1]).toMatchObject({ text: '3', enter: false })
    await act(async () => vi.advanceTimersByTimeAsync(MOBILE_NATIVE_CHAT_QUESTION_STEP_MS))
    expect(sendRequest.mock.calls[2]?.[1]).toMatchObject({ text: '\x1b[C', enter: false })
    await act(async () => vi.advanceTimersByTimeAsync(MOBILE_NATIVE_CHAT_QUESTION_STEP_MS))
    await expect(result).resolves.toBe(true)
    expect(sendRequest.mock.calls[3]?.[1]).toMatchObject({ text: '\r', enter: false })
  })

  it('multi-question: option numbers auto-advance, one final submit Enter', async () => {
    const sendRequest = vi.fn().mockResolvedValue(acceptedResponse())
    await mount({ sendRequest } as unknown as RpcClient, vi.fn())

    const prompt: AskPrompt = {
      questions: [
        { question: 'q1', multiSelect: false, options: [{ label: 'A' }, { label: 'B' }] },
        { question: 'q2', multiSelect: false, options: [{ label: 'C' }, { label: 'D' }] }
      ]
    }
    let result: Promise<boolean> | undefined
    await act(async () => {
      result = answerSend?.answerAsk(prompt, [{ indices: [1] }, { indices: [0] }])
    })
    await act(async () => vi.runAllTimersAsync())

    await expect(result).resolves.toBe(true)
    expect(sendRequest.mock.calls.map((call) => call[1])).toEqual([
      expect.objectContaining({ text: '2', enter: false }),
      expect.objectContaining({ text: '1', enter: false }),
      expect.objectContaining({ text: '\r', enter: false })
    ])
  })

  it('free text: opens "Type something", types the sanitized answer, then Enter', async () => {
    const sendRequest = vi.fn().mockResolvedValue(acceptedResponse())
    await mount({ sendRequest } as unknown as RpcClient, vi.fn())

    let result: Promise<boolean> | undefined
    await act(async () => {
      // A newline in raw keystrokes would submit early — must collapse to space.
      result = answerSend?.answerAsk(TABS_OR_SPACES, [{ indices: [], other: 'zeta\nspaces' }])
    })
    await act(async () => vi.runAllTimersAsync())

    await expect(result).resolves.toBe(true)
    expect(sendRequest.mock.calls.map((call) => call[1])).toEqual([
      expect.objectContaining({ text: '3', enter: false }),
      expect.objectContaining({ text: 'zeta spaces', enter: false }),
      expect.objectContaining({ text: '\r', enter: false })
    ])
  })

  it('answers OpenClaude asks with Claude selector keystrokes', async () => {
    const sendRequest = vi.fn().mockResolvedValue(acceptedResponse())
    await mount({ sendRequest } as unknown as RpcClient, vi.fn(), 'openclaude')

    await expect(answerSend?.answerAsk(TABS_OR_SPACES, [{ indices: [1] }])).resolves.toBe(true)
    expect(sendRequest).toHaveBeenCalledTimes(1)
    expect(sendRequest.mock.calls[0]?.[1]).toMatchObject({ text: '2', enter: false })
  })

  it('submits a Codex answer by option-number keystroke like Claude', async () => {
    const sendRequest = vi.fn().mockResolvedValue(acceptedResponse())
    await mount({ sendRequest } as unknown as RpcClient, vi.fn(), 'codex')

    await expect(answerSend?.answerAsk(TABS_OR_SPACES, [{ indices: [1] }])).resolves.toBe(true)
    // Codex's request_user_input card ignores pasted labels; the digit selects AND commits.
    expect(sendRequest).toHaveBeenCalledTimes(1)
    expect(sendRequest.mock.calls[0]?.[1]).toMatchObject({ text: '2', enter: false })
  })

  it('does not send a trailing Enter after Codex submits a multi-question answer', async () => {
    const sendRequest = vi.fn().mockResolvedValue(acceptedResponse())
    await mount({ sendRequest } as unknown as RpcClient, vi.fn(), 'codex')
    const prompt: AskPrompt = {
      questions: [
        { question: 'q1', multiSelect: false, options: [{ label: 'A' }, { label: 'B' }] },
        { question: 'q2', multiSelect: false, options: [{ label: 'C' }, { label: 'D' }] }
      ]
    }

    let result: Promise<boolean> | undefined
    await act(async () => {
      result = answerSend?.answerAsk(prompt, [{ indices: [1] }, { indices: [0] }])
    })
    await act(async () => vi.runAllTimersAsync())

    await expect(result).resolves.toBe(true)
    expect(sendRequest.mock.calls.map((call) => call[1])).toEqual([
      expect.objectContaining({ text: '2', enter: false }),
      expect.objectContaining({ text: '1', enter: false })
    ])
  })

  it('submits a non-selector answer as pasted label text with a single Enter', async () => {
    const sendRequest = vi.fn().mockResolvedValue(acceptedResponse())
    await mount({ sendRequest } as unknown as RpcClient, vi.fn(), 'grok')

    await expect(answerSend?.answerAsk(TABS_OR_SPACES, [{ indices: [1] }])).resolves.toBe(true)
    // Grok's question tool commits the pasted answer: label text + one Enter.
    expect(sendRequest).toHaveBeenCalledTimes(1)
    expect(sendRequest.mock.calls[0]?.[1]).toMatchObject({ text: 'Spaces', enter: true })
  })

  it('stops at the first rejected write and reports failure', async () => {
    const onSendError = vi.fn()
    const sendRequest = vi.fn().mockResolvedValue({
      id: 'send',
      ok: true,
      result: { send: { accepted: false } },
      _meta: { runtimeId: 'runtime' }
    })
    await mount({ sendRequest } as unknown as RpcClient, onSendError)

    await expect(answerSend?.answerAsk(TABS_OR_SPACES, [{ indices: [1] }])).resolves.toBe(false)
    expect(sendRequest).toHaveBeenCalledTimes(1)
    expect(onSendError).toHaveBeenCalledWith('Answer not sent')
  })

  it('rejects an empty selection without writing anything', async () => {
    const sendRequest = vi.fn().mockResolvedValue(acceptedResponse())
    await mount({ sendRequest } as unknown as RpcClient, vi.fn())

    await expect(answerSend?.answerAsk(TABS_OR_SPACES, [{ indices: [] }])).resolves.toBe(false)
    expect(sendRequest).not.toHaveBeenCalled()
  })

  it('cancels delayed keystrokes when the acknowledged input lease is lost', async () => {
    const sendRequest = vi.fn().mockResolvedValue(acceptedResponse())
    await mount({ sendRequest } as unknown as RpcClient, vi.fn())

    const prompt: AskPrompt = {
      questions: [
        { question: 'q1', multiSelect: false, options: [{ label: 'A' }, { label: 'B' }] },
        { question: 'q2', multiSelect: false, options: [{ label: 'C' }, { label: 'D' }] }
      ]
    }
    let result: Promise<boolean> | undefined
    await act(async () => {
      result = answerSend?.answerAsk(prompt, [{ indices: [1] }, { indices: [0] }])
    })
    expect(sendRequest).toHaveBeenCalledTimes(1)

    await setEnabled(false)
    await act(async () => vi.runAllTimersAsync())

    await expect(result).resolves.toBe(false)
    expect(sendRequest).toHaveBeenCalledTimes(1)
  })
})
