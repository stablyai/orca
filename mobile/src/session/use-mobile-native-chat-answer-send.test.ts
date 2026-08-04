import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentType } from '../../../src/shared/native-chat-types'
import type { RpcClient } from '../transport/rpc-client'
import { markRpcDeliveryUnknown } from '../transport/rpc-delivery-ambiguity'
import { MOBILE_NATIVE_CHAT_QUESTION_STEP_MS } from './mobile-native-chat-answer-stepping'
import type { AskPrompt } from './mobile-native-chat-ask'
import {
  isMobileNativeChatInputStale,
  markMobileNativeChatInputStale,
  resetMobileNativeChatStaleInputForTests
} from './mobile-native-chat-stale-input'
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
    resetMobileNativeChatStaleInputForTests()
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

  it('bounds a stepped answer with one shared budget, crediting back the pacing waits', async () => {
    const timeouts: number[] = []
    const sendRequest = vi.fn(async (_method: string, _params?: unknown, options?: unknown) => {
      timeouts.push((options as { timeoutMs: number }).timeoutMs)
      // A slow write must eat into what the rest of the answer has left.
      vi.advanceTimersByTime(6_000)
      return acceptedResponse()
    })
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
    await act(async () => vi.advanceTimersByTimeAsync(MOBILE_NATIVE_CHAT_QUESTION_STEP_MS))
    await act(async () => vi.advanceTimersByTimeAsync(MOBILE_NATIVE_CHAT_QUESTION_STEP_MS))

    await expect(result).resolves.toBe(true)
    // 15s total transport, minus 6s per completed write; the 1s pacing steps are
    // deliberate and are added back, so they never shrink the budget.
    expect(timeouts).toEqual([15_000, 9_000, 3_000])
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

  it('clears an orphaned image paste before an answer that commits with Enter (#10228)', async () => {
    const sendRequest = vi.fn().mockResolvedValue(acceptedResponse())
    await mount({ sendRequest } as unknown as RpcClient, vi.fn(), 'grok')
    // An earlier image send left its path on this terminal's composer line.
    markMobileNativeChatInputStale('terminal')

    await expect(answerSend?.answerAsk(TABS_OR_SPACES, [{ indices: [1] }])).resolves.toBe(true)
    // Without the leading clear, the pasted label + Enter would submit
    // "<image path>Spaces" as one prompt.
    expect(sendRequest).toHaveBeenCalledTimes(2)
    expect(sendRequest.mock.calls[0]?.[1]).toMatchObject({ text: '\x15', enter: false })
    expect(sendRequest.mock.calls[1]?.[1]).toMatchObject({ text: 'Spaces', enter: true })
    expect(isMobileNativeChatInputStale('terminal')).toBe(false)
  })

  it('keeps the marker for a selector answer, which cannot submit the composer', async () => {
    const sendRequest = vi.fn().mockResolvedValue(acceptedResponse())
    await mount({ sendRequest } as unknown as RpcClient, vi.fn(), 'claude')
    markMobileNativeChatInputStale('terminal')

    await expect(answerSend?.answerAsk(TABS_OR_SPACES, [{ indices: [1] }])).resolves.toBe(true)
    // A single-select answer is a bare option digit against a live overlay: the
    // clear would be swallowed but still acked, burning the marker and leaving the
    // paste to corrupt the next real message. Only the digit may go.
    expect(sendRequest).toHaveBeenCalledTimes(1)
    expect(sendRequest.mock.calls[0]?.[1]).toMatchObject({ text: '2', enter: false })
    expect(isMobileNativeChatInputStale('terminal')).toBe(true)
  })

  it('does not answer when the healing clear is rejected, keeping the marker', async () => {
    const onSendError = vi.fn()
    const sendRequest = vi.fn().mockResolvedValue({
      id: 'send',
      ok: true as const,
      result: { send: { accepted: false } },
      _meta: { runtimeId: 'runtime' }
    })
    await mount({ sendRequest } as unknown as RpcClient, onSendError, 'grok')
    markMobileNativeChatInputStale('terminal')

    await expect(answerSend?.answerAsk(TABS_OR_SPACES, [{ indices: [1] }])).resolves.toBe(false)
    // Only the clear was attempted; the answer must not ride on a dirty line.
    expect(sendRequest).toHaveBeenCalledTimes(1)
    expect(sendRequest.mock.calls[0]?.[1]).toMatchObject({ text: '\x15', enter: false })
    expect(onSendError).toHaveBeenCalledWith('Answer not sent')
    expect(isMobileNativeChatInputStale('terminal')).toBe(true)
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

  it('does not call a budget-truncated multi-question answer a definite non-send', async () => {
    const onSendError = vi.fn()
    const sendRequest = vi.fn(async () => {
      // A slow relay: the first group lands, then the shared budget is gone and the
      // next write short-circuits to 'rejected' without reaching the wire.
      vi.advanceTimersByTime(16_000)
      return acceptedResponse()
    })
    await mount({ sendRequest } as unknown as RpcClient, onSendError)

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

    await expect(result).resolves.toBe(false)
    // The first group DID land, so the remote selector is half-stepped — telling the
    // user nothing was sent invites a retry on top of the advanced state.
    expect(onSendError).toHaveBeenCalledWith('Answer partly sent — check chat before retrying')
  })

  it('reports an ambiguous write as unconfirmed instead of a definite failure', async () => {
    const onSendError = vi.fn()
    const sendRequest = vi
      .fn()
      .mockRejectedValue(markRpcDeliveryUnknown(new Error('Connection closed')))
    await mount({ sendRequest } as unknown as RpcClient, onSendError)

    await expect(answerSend?.answerAsk(TABS_OR_SPACES, [{ indices: [1] }])).resolves.toBe(false)
    expect(onSendError).toHaveBeenCalledWith('Answer unconfirmed — check chat before retrying')
  })

  it('rejects an empty selection without writing anything', async () => {
    const sendRequest = vi.fn().mockResolvedValue(acceptedResponse())
    await mount({ sendRequest } as unknown as RpcClient, vi.fn())

    await expect(answerSend?.answerAsk(TABS_OR_SPACES, [{ indices: [] }])).resolves.toBe(false)
    expect(sendRequest).not.toHaveBeenCalled()
  })

  it('cancels delayed keystrokes when the acknowledged input lease is lost', async () => {
    const onSendError = vi.fn()
    const sendRequest = vi.fn().mockResolvedValue(acceptedResponse())
    await mount({ sendRequest } as unknown as RpcClient, onSendError)

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
    // q1's digit DID land before the lease loss aborted the chain, so the remote
    // selector sits on q2 — ending silently left the card looking cleanly sent.
    expect(onSendError).toHaveBeenCalledWith('Answer partly sent — check chat before retrying')
  })

  it('reports the half-stepped selector when Stop aborts a paced answer', async () => {
    const onSendError = vi.fn()
    const sendRequest = vi.fn().mockResolvedValue(acceptedResponse())
    await mount({ sendRequest } as unknown as RpcClient, onSendError)

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

    await act(async () => {
      answerSend?.cancelPending()
      await vi.runAllTimersAsync()
    })

    await expect(result).resolves.toBe(false)
    expect(sendRequest).toHaveBeenCalledTimes(1)
    expect(onSendError).toHaveBeenCalledWith('Answer partly sent — check chat before retrying')
  })

  it('reports a superseded chain whose first group already moved the selector', async () => {
    const onSendError = vi.fn()
    const sendRequest = vi.fn().mockResolvedValue(acceptedResponse())
    await mount({ sendRequest } as unknown as RpcClient, onSendError)

    const prompt: AskPrompt = {
      questions: [
        { question: 'q1', multiSelect: false, options: [{ label: 'A' }, { label: 'B' }] },
        { question: 'q2', multiSelect: false, options: [{ label: 'C' }, { label: 'D' }] }
      ]
    }
    let first: Promise<boolean> | undefined
    await act(async () => {
      first = answerSend?.answerAsk(prompt, [{ indices: [1] }, { indices: [0] }])
    })
    expect(sendRequest).toHaveBeenCalledTimes(1)

    // Changing the answer mid-sequence supersedes the chain, but q1's digit is
    // already committed on the host — the replacement starts from a moved selector.
    await act(async () => {
      void answerSend?.answerAsk(TABS_OR_SPACES, [{ indices: [1] }])
      await vi.runAllTimersAsync()
    })

    await expect(first).resolves.toBe(false)
    expect(onSendError).toHaveBeenCalledWith('Answer partly sent — check chat before retrying')
  })

  it('keeps an ambiguous write ambiguous when the chain is aborted after it', async () => {
    const onSendError = vi.fn()
    let rejectWrite: (error: Error) => void = () => undefined
    const sendRequest = vi.fn(
      () =>
        new Promise((_resolve, reject) => {
          rejectWrite = reject
        })
    )
    await mount({ sendRequest } as unknown as RpcClient, onSendError)

    let result: Promise<boolean> | undefined
    await act(async () => {
      result = answerSend?.answerAsk(TABS_OR_SPACES, [{ indices: [1] }])
      await Promise.resolve()
    })
    expect(sendRequest).toHaveBeenCalledTimes(1)

    await act(async () => {
      answerSend?.cancelPending()
      rejectWrite(markRpcDeliveryUnknown(new Error('Connection closed')))
      await vi.runAllTimersAsync()
    })

    await expect(result).resolves.toBe(false)
    // The abort says nothing about whether the in-flight keystroke landed.
    expect(onSendError).toHaveBeenCalledWith('Answer unconfirmed — check chat before retrying')
  })

  it('stays silent when an aborted chain never got a keystroke onto the wire', async () => {
    const onSendError = vi.fn()
    let settleWrite: (response: unknown) => void = () => undefined
    const sendRequest = vi.fn(
      () =>
        new Promise((resolve) => {
          settleWrite = resolve
        })
    )
    await mount({ sendRequest } as unknown as RpcClient, onSendError)

    let result: Promise<boolean> | undefined
    await act(async () => {
      result = answerSend?.answerAsk(TABS_OR_SPACES, [{ indices: [1] }])
      await Promise.resolve()
    })
    expect(sendRequest).toHaveBeenCalledTimes(1)

    await act(async () => {
      answerSend?.cancelPending()
      settleWrite({
        id: 'send',
        ok: true as const,
        result: { send: { accepted: false } },
        _meta: { runtimeId: 'runtime' }
      })
      await vi.runAllTimersAsync()
    })

    await expect(result).resolves.toBe(false)
    // Nothing reached the PTY and the user already moved on — no banner to raise.
    expect(onSendError).not.toHaveBeenCalled()
  })
})
