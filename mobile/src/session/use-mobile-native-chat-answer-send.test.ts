import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AskPrompt } from '../../../src/shared/native-chat-ask'
import type { AgentType } from '../../../src/shared/native-chat-types'
import type { RpcClient } from '../transport/rpc-client'
import { markRpcDeliveryUnknown } from '../transport/rpc-delivery-ambiguity'
import { MOBILE_NATIVE_CHAT_QUESTION_STEP_MS } from './mobile-native-chat-answer-stepping'
import {
  isMobileNativeChatInputStale,
  markMobileNativeChatInputStale,
  resetMobileNativeChatStaleInputForTests
} from './mobile-native-chat-stale-input'
import {
  acquireMobileNativeChatTerminalWrite,
  releaseMobileNativeChatTerminalWrite,
  resetMobileNativeChatTerminalWritesForTests
} from './mobile-native-chat-terminal-write-lock'
import { useMobileNativeChatAnswerSend } from './use-mobile-native-chat-answer-send'
import { useNativeChatAcceptedAction } from './use-native-chat-action-outcomes'

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
  // The route sends through useNativeChatAcceptedAction, whose accepted callback
  // retires the shared send-error banner (use-mobile-native-chat-controller.ts).
  let acceptedAnswerAsk: AnswerSend['answerAsk'] | null = null
  let onAccepted = vi.fn()

  beforeEach(() => {
    onAccepted = vi.fn()
    vi.useFakeTimers()
    resetMobileNativeChatStaleInputForTests()
    resetMobileNativeChatTerminalWritesForTests()
  })

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    answerSend = null
    acceptedAnswerAsk = null
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
    acceptedAnswerAsk = useNativeChatAcceptedAction(answerSend.answerAsk, onAccepted)
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
    await act(async () => {
      renderer = create(createElement(Harness, { enabled: true }))
    })
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

  it('rejects an answer while another composed write holds the terminal', async () => {
    const onSendError = vi.fn()
    const sendRequest = vi.fn().mockResolvedValue(acceptedResponse())
    await mount({ sendRequest } as unknown as RpcClient, onSendError)

    // An image paste sequence is mid-flight into the same PTY.
    expect(acquireMobileNativeChatTerminalWrite('terminal')).toBe(true)
    await expect(answerSend?.answerAsk(TABS_OR_SPACES, [{ indices: [1] }])).resolves.toBe(false)
    expect(sendRequest).not.toHaveBeenCalled()
    expect(onSendError).toHaveBeenCalledWith('Answer not sent')

    // Once that sequence releases, answers flow again.
    releaseMobileNativeChatTerminalWrite('terminal')
    await expect(answerSend?.answerAsk(TABS_OR_SPACES, [{ indices: [1] }])).resolves.toBe(true)
  })

  it('answers again on the same handle after an earlier answer already landed', async () => {
    const onSendError = vi.fn()
    const sendRequest = vi.fn().mockResolvedValue(acceptedResponse())
    await mount({ sendRequest } as unknown as RpcClient, onSendError)

    await expect(answerSend?.answerAsk(TABS_OR_SPACES, [{ indices: [0] }])).resolves.toBe(true)
    // A landed answer resolves its turn FALSE — correct for a queued successor,
    // fatal if the turn outlives the chain. Leaving it parked in the slot fences
    // every later answer on this handle for the life of the hook, not just an
    // overlapping one, so the ask card dies after its first use.
    await expect(answerSend?.answerAsk(TABS_OR_SPACES, [{ indices: [1] }])).resolves.toBe(true)
    expect(sendRequest).toHaveBeenCalledTimes(2)
    expect(onSendError).not.toHaveBeenCalled()
  })

  it('fences a superseding answer after the cancelled chain moved the selector', async () => {
    const sendRequest = vi.fn().mockResolvedValue(acceptedResponse())
    await mount({ sendRequest } as unknown as RpcClient, vi.fn())

    const prompt: AskPrompt = {
      questions: [
        { question: 'q1', multiSelect: false, options: [{ label: 'A' }, { label: 'B' }] },
        { question: 'q2', multiSelect: false, options: [{ label: 'C' }, { label: 'D' }] }
      ]
    }
    let first: Promise<boolean> | undefined
    let second: Promise<boolean> | undefined
    await act(async () => {
      first = answerSend?.answerAsk(prompt, [{ indices: [0] }, { indices: [0] }])
    })
    // The first digit already advanced Claude to q2. Replaying a from-q1 key
    // plan now would answer the wrong question.
    await act(async () => {
      second = answerSend?.answerAsk(TABS_OR_SPACES, [{ indices: [1] }])
    })
    await act(async () => vi.runAllTimersAsync())

    await expect(first).resolves.toBe(false)
    await expect(second).resolves.toBe(false)
    expect(sendRequest).toHaveBeenCalledTimes(1)
    // Both chains unwound: the terminal is free for the next composed write.
    expect(acquireMobileNativeChatTerminalWrite('terminal')).toBe(true)
    releaseMobileNativeChatTerminalWrite('terminal')
  })

  it('does not write a successor after the prior in-flight key is accepted', async () => {
    let resolveFirst: (response: unknown) => void = () => undefined
    const sendRequest = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve
          })
      )
      .mockResolvedValue(acceptedResponse())
    await mount({ sendRequest } as unknown as RpcClient, vi.fn())

    const prompt: AskPrompt = {
      questions: [
        { question: 'q1', multiSelect: false, options: [{ label: 'A' }, { label: 'B' }] },
        { question: 'q2', multiSelect: false, options: [{ label: 'C' }, { label: 'D' }] }
      ]
    }
    let first: Promise<boolean> | undefined
    let second: Promise<boolean> | undefined
    await act(async () => {
      first = answerSend?.answerAsk(prompt, [{ indices: [0] }, { indices: [0] }])
      await Promise.resolve()
    })
    await act(async () => {
      second = answerSend?.answerAsk(TABS_OR_SPACES, [{ indices: [1] }])
      await Promise.resolve()
    })

    // The successor is queued behind the in-flight key, not racing it.
    expect(sendRequest).toHaveBeenCalledTimes(1)
    await act(async () => {
      resolveFirst(acceptedResponse())
      await Promise.resolve()
    })
    await expect(first).resolves.toBe(false)
    await expect(second).resolves.toBe(false)
    expect(sendRequest).toHaveBeenCalledTimes(1)
  })

  it('lets a queued successor continue after the prior key is definitely rejected', async () => {
    let resolveFirst: (response: unknown) => void = () => undefined
    const sendRequest = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve
          })
      )
      .mockResolvedValue(acceptedResponse())
    await mount({ sendRequest } as unknown as RpcClient, vi.fn())

    let first: Promise<boolean> | undefined
    let second: Promise<boolean> | undefined
    await act(async () => {
      first = answerSend?.answerAsk(TABS_OR_SPACES, [{ indices: [0] }])
      await Promise.resolve()
    })
    await act(async () => {
      second = answerSend?.answerAsk(TABS_OR_SPACES, [{ indices: [1] }])
      await Promise.resolve()
    })
    await act(async () => {
      resolveFirst({
        ...acceptedResponse(),
        result: { send: { accepted: false } }
      })
      await Promise.resolve()
    })

    // Nothing landed, so the selector never moved — the successor is safe.
    await expect(first).resolves.toBe(false)
    await expect(second).resolves.toBe(true)
    expect(sendRequest).toHaveBeenCalledTimes(2)
  })

  it('does not write a successor after the prior delivery becomes ambiguous', async () => {
    let rejectFirst: (error: Error) => void = () => undefined
    const sendRequest = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            rejectFirst = reject
          })
      )
      .mockResolvedValue(acceptedResponse())
    await mount({ sendRequest } as unknown as RpcClient, vi.fn())

    let first: Promise<boolean> | undefined
    let second: Promise<boolean> | undefined
    await act(async () => {
      first = answerSend?.answerAsk(TABS_OR_SPACES, [{ indices: [0] }])
      await Promise.resolve()
    })
    await act(async () => {
      second = answerSend?.answerAsk(TABS_OR_SPACES, [{ indices: [1] }])
      await Promise.resolve()
    })
    await act(async () => {
      rejectFirst(markRpcDeliveryUnknown(new Error('Connection closed')))
      await Promise.resolve()
    })

    // The key may have landed; a blind successor could double-step the selector.
    await expect(first).resolves.toBe(false)
    await expect(second).resolves.toBe(false)
    expect(sendRequest).toHaveBeenCalledTimes(1)
  })

  it('tells the user when a queued answer is fenced instead of dropping it silently', async () => {
    const onSendError = vi.fn()
    let rejectFirst: (error: Error) => void = () => undefined
    const sendRequest = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            rejectFirst = reject
          })
      )
      .mockResolvedValue(acceptedResponse())
    await mount({ sendRequest } as unknown as RpcClient, onSendError)

    let first: Promise<boolean> | undefined
    let second: Promise<boolean> | undefined
    await act(async () => {
      first = answerSend?.answerAsk(TABS_OR_SPACES, [{ indices: [0] }])
      await Promise.resolve()
    })
    await act(async () => {
      second = answerSend?.answerAsk(TABS_OR_SPACES, [{ indices: [1] }])
      await Promise.resolve()
    })
    await act(async () => {
      rejectFirst(markRpcDeliveryUnknown(new Error('Connection closed')))
      await Promise.resolve()
    })

    await expect(first).resolves.toBe(false)
    await expect(second).resolves.toBe(false)
    // The card re-enables on a false result, so an unreported fence looks exactly
    // like a dead button. The superseded chain stays quiet — the newest answer
    // owns the error surface, and it is the one the user is waiting on.
    expect(onSendError).toHaveBeenCalledTimes(1)
    expect(onSendError).toHaveBeenCalledWith('Answer not sent — check chat before retrying')
  })

  it('tells the user when a dropped lease fences a queued answer whose predecessor landed', async () => {
    const onSendError = vi.fn()
    const settle: Array<(response: unknown) => void> = []
    const sendRequest = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          settle.push(resolve)
        })
    )
    await mount({ sendRequest } as unknown as RpcClient, onSendError)

    let first: Promise<boolean> | undefined
    let second: Promise<boolean> | undefined
    await act(async () => {
      first = answerSend?.answerAsk(TABS_OR_SPACES, [{ indices: [1] }])
      await Promise.resolve()
    })
    await act(async () => {
      second = answerSend?.answerAsk(TABS_OR_SPACES, [{ indices: [0] }])
      await Promise.resolve()
    })
    // A transport blip, not a user cancel: unlike Stop and ask-cancel, the lost
    // input lease writes no Escape, so the card stays up with Submit re-enabled.
    await setEnabled(false)
    await act(async () => {
      settle[0]!(acceptedResponse())
      await Promise.resolve()
    })

    expect(sendRequest).toHaveBeenCalledTimes(1)
    await expect(first).resolves.toBe(false)
    await expect(second).resolves.toBe(false)
    // The first option key LANDED, so the live selector already moved. Reporting
    // nothing invites a retry that double-steps it.
    expect(onSendError).toHaveBeenCalledTimes(1)
    expect(onSendError).toHaveBeenCalledWith('Answer not sent — check chat before retrying')
  })

  it('keeps the terminal locked while a queued successor writes', async () => {
    const settle: Array<(response: unknown) => void> = []
    const sendRequest = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          settle.push(resolve)
        })
    )
    await mount({ sendRequest } as unknown as RpcClient, vi.fn())

    let first: Promise<boolean> | undefined
    let second: Promise<boolean> | undefined
    await act(async () => {
      first = answerSend?.answerAsk(TABS_OR_SPACES, [{ indices: [0] }])
      await Promise.resolve()
    })
    await act(async () => {
      second = answerSend?.answerAsk(TABS_OR_SPACES, [{ indices: [1] }])
      await Promise.resolve()
    })
    expect(sendRequest).toHaveBeenCalledTimes(1)

    // Nothing landed, so the successor is cleared to write.
    await act(async () => {
      settle[0]!({ ...acceptedResponse(), result: { send: { accepted: false } } })
      await Promise.resolve()
    })
    expect(sendRequest).toHaveBeenCalledTimes(2)
    // The successor's key is on the wire. The superseded chain unwinding behind it
    // must NOT free the terminal, or an image paste interleaves into this sequence.
    expect(acquireMobileNativeChatTerminalWrite('terminal')).toBe(false)

    await act(async () => {
      settle[1]!(acceptedResponse())
      await Promise.resolve()
    })
    await expect(first).resolves.toBe(false)
    await expect(second).resolves.toBe(true)
    expect(acquireMobileNativeChatTerminalWrite('terminal')).toBe(true)
    releaseMobileNativeChatTerminalWrite('terminal')
  })

  it('does not retire the fence banner when the superseded answer lands', async () => {
    const onSendError = vi.fn()
    const settle: Array<(response: unknown) => void> = []
    const sendRequest = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          settle.push(resolve)
        })
    )
    await mount({ sendRequest } as unknown as RpcClient, onSendError)

    let first: Promise<boolean> | undefined
    let second: Promise<boolean> | undefined
    await act(async () => {
      first = acceptedAnswerAsk?.(TABS_OR_SPACES, [{ indices: [0] }])
      await Promise.resolve()
    })
    await act(async () => {
      second = acceptedAnswerAsk?.(TABS_OR_SPACES, [{ indices: [1] }])
      await Promise.resolve()
    })
    // The healthy path: the first answer LANDS, which is also the case that fences
    // hardest — its key moved the live selector.
    await act(async () => {
      settle[0]!(acceptedResponse())
      await Promise.resolve()
    })

    await expect(first).resolves.toBe(false)
    await expect(second).resolves.toBe(false)
    expect(onSendError).toHaveBeenCalledWith('Answer not sent — check chat before retrying')
    // A superseded chain reporting success would clear the banner it just raised —
    // the accepted hook runs after the fence, so the user would see nothing at all.
    expect(onAccepted).not.toHaveBeenCalled()
    expect(sendRequest).toHaveBeenCalledTimes(1)
  })

  it('does not retire the fence banner when a superseded pasted answer lands', async () => {
    const onSendError = vi.fn()
    const settle: Array<(response: unknown) => void> = []
    const sendRequest = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          settle.push(resolve)
        })
    )
    await mount({ sendRequest } as unknown as RpcClient, onSendError, 'grok')

    let first: Promise<boolean> | undefined
    let second: Promise<boolean> | undefined
    await act(async () => {
      first = acceptedAnswerAsk?.(TABS_OR_SPACES, [{ indices: [0] }])
      await Promise.resolve()
    })
    await act(async () => {
      second = acceptedAnswerAsk?.(TABS_OR_SPACES, [{ indices: [1] }])
      await Promise.resolve()
    })
    await act(async () => {
      settle[0]!(acceptedResponse())
      await Promise.resolve()
    })

    // The pasted shape commits with Enter, so a superseded chain is doubly unsafe
    // to report as accepted — the answer it committed is not the one on screen.
    await expect(first).resolves.toBe(false)
    await expect(second).resolves.toBe(false)
    expect(onAccepted).not.toHaveBeenCalled()
    expect(onSendError).toHaveBeenCalledWith('Answer not sent — check chat before retrying')
  })

  it('reports a landed answer that Stop cancelled with no successor waiting', async () => {
    const onSendError = vi.fn()
    const settle: Array<(response: unknown) => void> = []
    const sendRequest = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          settle.push(resolve)
        })
    )
    await mount({ sendRequest } as unknown as RpcClient, onSendError)

    let first: Promise<boolean> | undefined
    await act(async () => {
      first = acceptedAnswerAsk?.(TABS_OR_SPACES, [{ indices: [1] }])
      await Promise.resolve()
    })
    // Stop, an ask cancel, and a dropped input lease all bump the generation with
    // NO successor chain behind them.
    await act(async () => {
      answerSend?.cancelPending()
      settle[0]!(acceptedResponse())
      await Promise.resolve()
    })

    // The key is on the PTY and nobody else owns the surface. Calling that a
    // non-send leaves the card up and silent (fail() never runs on an accepted
    // write), and the retry double-steps the selector this key already moved.
    await expect(first).resolves.toBe(true)
    expect(onAccepted).toHaveBeenCalledTimes(1)
    expect(onSendError).not.toHaveBeenCalled()
  })

  it('reports a landed pasted answer that Stop cancelled with no successor', async () => {
    const onSendError = vi.fn()
    const settle: Array<(response: unknown) => void> = []
    const sendRequest = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          settle.push(resolve)
        })
    )
    await mount({ sendRequest } as unknown as RpcClient, onSendError, 'grok')

    let first: Promise<boolean> | undefined
    await act(async () => {
      first = acceptedAnswerAsk?.(TABS_OR_SPACES, [{ indices: [1] }])
      await Promise.resolve()
    })
    await act(async () => {
      answerSend?.cancelPending()
      settle[0]!(acceptedResponse())
      await Promise.resolve()
    })

    // The pasted shape already committed with Enter, so suppressing the success
    // strands an answered card the user is invited to submit a second time.
    await expect(first).resolves.toBe(true)
    expect(onAccepted).toHaveBeenCalledTimes(1)
    expect(onSendError).not.toHaveBeenCalled()
  })

  it('fences a third answer behind an already-fenced successor, reporting once', async () => {
    const onSendError = vi.fn()
    const settle: Array<(response: unknown) => void> = []
    const sendRequest = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          settle.push(resolve)
        })
    )
    await mount({ sendRequest } as unknown as RpcClient, onSendError)

    let first: Promise<boolean> | undefined
    let second: Promise<boolean> | undefined
    let third: Promise<boolean> | undefined
    await act(async () => {
      first = answerSend?.answerAsk(TABS_OR_SPACES, [{ indices: [0] }])
      await Promise.resolve()
    })
    await act(async () => {
      second = answerSend?.answerAsk(TABS_OR_SPACES, [{ indices: [1] }])
      await Promise.resolve()
    })
    await act(async () => {
      third = answerSend?.answerAsk(TABS_OR_SPACES, [{ indices: [0] }])
      await Promise.resolve()
    })
    expect(sendRequest).toHaveBeenCalledTimes(1)

    await act(async () => {
      settle[0]!(acceptedResponse())
      await Promise.resolve()
    })
    await expect(first).resolves.toBe(false)
    await expect(second).resolves.toBe(false)
    await expect(third).resolves.toBe(false)
    // The middle chain sent nothing, so only the verdict it INHERITED can stop the
    // third from replaying a from-scratch plan onto the advanced selector.
    expect(sendRequest).toHaveBeenCalledTimes(1)
    // Only the newest chain owns the error surface.
    expect(onSendError).toHaveBeenCalledTimes(1)
    expect(onSendError).toHaveBeenCalledWith('Answer not sent — check chat before retrying')
  })

  it('queues a late third answer behind the successor already on the wire', async () => {
    const settle: Array<(response: unknown) => void> = []
    const sendRequest = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          settle.push(resolve)
        })
    )
    await mount({ sendRequest } as unknown as RpcClient, vi.fn())

    let first: Promise<boolean> | undefined
    let second: Promise<boolean> | undefined
    let third: Promise<boolean> | undefined
    await act(async () => {
      first = answerSend?.answerAsk(TABS_OR_SPACES, [{ indices: [0] }])
      await Promise.resolve()
    })
    await act(async () => {
      second = answerSend?.answerAsk(TABS_OR_SPACES, [{ indices: [1] }])
      await Promise.resolve()
    })
    // Nothing landed, so the successor is cleared and puts its own key on the wire.
    await act(async () => {
      settle[0]!({ ...acceptedResponse(), result: { send: { accepted: false } } })
      await Promise.resolve()
    })
    expect(sendRequest).toHaveBeenCalledTimes(2)

    await act(async () => {
      third = answerSend?.answerAsk(TABS_OR_SPACES, [{ indices: [0] }])
      await Promise.resolve()
      await Promise.resolve()
    })
    // The first chain unwound while the second was mid-write: it must not have
    // dropped the second's turn, or this one writes into the same PTY concurrently.
    expect(sendRequest).toHaveBeenCalledTimes(2)

    await act(async () => {
      settle[1]!(acceptedResponse())
      await Promise.resolve()
    })
    await expect(first).resolves.toBe(false)
    await expect(second).resolves.toBe(false)
    await expect(third).resolves.toBe(false)
    expect(sendRequest).toHaveBeenCalledTimes(2)
  })
})
