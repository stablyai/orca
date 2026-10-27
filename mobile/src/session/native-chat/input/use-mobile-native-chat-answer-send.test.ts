vi.mock('../../../terminal/worker-terminal-takeover-report', () => ({
  reportWorkerTerminalUserInput: vi.fn()
}))

import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AskPrompt } from '../../../../../src/shared/native-chat-ask'
import type { AgentType } from '../../../../../src/shared/native-chat-types'
import { buildNativeChatPasteBytes } from '../../../../../src/shared/native-chat-paste-bytes'
import type { RpcClient } from '../../../transport/rpc-client'
import { markRpcDeliveryUnknown } from '../../../transport/rpc-delivery-ambiguity'
import { MOBILE_NATIVE_CHAT_QUESTION_STEP_MS } from './mobile-native-chat-answer-stepping'
import {
  isMobileNativeChatInputStale,
  markMobileNativeChatInputStale,
  resetMobileNativeChatStaleInputForTests
} from '../mobile-native-chat-stale-input'
import {
  acquireMobileNativeChatTerminalWrite,
  releaseMobileNativeChatTerminalWrite,
  resetMobileNativeChatTerminalWritesForTests
} from '../mobile-native-chat-terminal-write-lock'
import { useMobileNativeChatAnswerSend } from './use-mobile-native-chat-answer-send'
import { useNativeChatAcceptedAction } from '../../use-native-chat-action-outcomes'
import { stubRpcClient } from '../../../transport/rpc-client-test-stub'

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

  it.each(['claude', 'opencode', 'opencode2'] as const)(
    '%s single-select: sends the picked option number without a trailing Enter',
    async (agent) => {
      const sendRequest = vi.fn().mockResolvedValue(acceptedResponse())
      await mount(stubRpcClient({ sendRequest }), vi.fn(), agent)

      // Spaces is option 2 — the STA-1860 case where label text committed Tabs.
      await expect(answerSend?.answerAsk(TABS_OR_SPACES, [{ indices: [1] }])).resolves.toBe(true)
      expect(sendRequest).toHaveBeenCalledTimes(1)
      expect(sendRequest.mock.calls[0]?.[1]).toMatchObject({ text: '2', enter: false })
    }
  )

  it.each(['claude', 'opencode', 'opencode2'] as const)(
    '%s multi-select: toggles option numbers and confirms in paced steps',
    async (agent) => {
      const sendRequest = vi.fn().mockResolvedValue(acceptedResponse())
      await mount(stubRpcClient({ sendRequest }), vi.fn(), agent)

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

      await act(async () => {
        await vi.advanceTimersByTimeAsync(MOBILE_NATIVE_CHAT_QUESTION_STEP_MS)
      })
      expect(sendRequest.mock.calls[1]?.[1]).toMatchObject({ text: '3', enter: false })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(MOBILE_NATIVE_CHAT_QUESTION_STEP_MS)
      })
      expect(sendRequest.mock.calls[2]?.[1]).toMatchObject({ text: '\x1b[C', enter: false })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(MOBILE_NATIVE_CHAT_QUESTION_STEP_MS)
      })
      await expect(result).resolves.toBe(true)
      expect(sendRequest.mock.calls[3]?.[1]).toMatchObject({ text: '\r', enter: false })
    }
  )

  it('multi-question: option numbers auto-advance, one final submit Enter', async () => {
    const sendRequest = vi.fn().mockResolvedValue(acceptedResponse())
    await mount(stubRpcClient({ sendRequest }), vi.fn())

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
    await act(async () => {
      await vi.runAllTimersAsync()
    })

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
      vi.advanceTimersByTime(6_000)
      return acceptedResponse()
    })
    await mount(stubRpcClient({ sendRequest }), vi.fn())

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
    await act(async () => {
      await vi.advanceTimersByTimeAsync(MOBILE_NATIVE_CHAT_QUESTION_STEP_MS)
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(MOBILE_NATIVE_CHAT_QUESTION_STEP_MS)
    })

    await expect(result).resolves.toBe(true)
    // Credit deliberate pacing back to the 15s budget; transport still spends 6s per completed write.
    expect(timeouts).toEqual([15_000, 9_000, 3_000])
  })

  it('free text: opens "Type something", pastes the multi-line answer, then Enter', async () => {
    const sendRequest = vi.fn().mockResolvedValue(acceptedResponse())
    await mount(stubRpcClient({ sendRequest }), vi.fn())

    let result: Promise<boolean> | undefined
    await act(async () => {
      result = answerSend?.answerAsk(TABS_OR_SPACES, [{ indices: [], other: 'zeta\nspaces' }])
    })
    await act(async () => {
      await vi.runAllTimersAsync()
    })

    await expect(result).resolves.toBe(true)
    expect(sendRequest.mock.calls.map((call) => call[1])).toEqual([
      expect.objectContaining({ text: '3', enter: false }),
      expect.objectContaining({ text: buildNativeChatPasteBytes('zeta\nspaces'), enter: false }),
      expect.objectContaining({ text: '\r', enter: false })
    ])
  })

  it('answers OpenClaude asks with Claude selector keystrokes', async () => {
    const sendRequest = vi.fn().mockResolvedValue(acceptedResponse())
    await mount(stubRpcClient({ sendRequest }), vi.fn(), 'openclaude')

    await expect(answerSend?.answerAsk(TABS_OR_SPACES, [{ indices: [1] }])).resolves.toBe(true)
    expect(sendRequest).toHaveBeenCalledTimes(1)
    expect(sendRequest.mock.calls[0]?.[1]).toMatchObject({ text: '2', enter: false })
  })

  it('submits a Codex answer by option-number keystroke like Claude', async () => {
    const sendRequest = vi.fn().mockResolvedValue(acceptedResponse())
    await mount(stubRpcClient({ sendRequest }), vi.fn(), 'codex')

    await expect(answerSend?.answerAsk(TABS_OR_SPACES, [{ indices: [1] }])).resolves.toBe(true)
    // Codex's request_user_input card ignores pasted labels; the digit selects AND commits.
    expect(sendRequest).toHaveBeenCalledTimes(1)
    expect(sendRequest.mock.calls[0]?.[1]).toMatchObject({ text: '2', enter: false })
  })

  it('does not send a trailing Enter after Codex submits a multi-question answer', async () => {
    const sendRequest = vi.fn().mockResolvedValue(acceptedResponse())
    await mount(stubRpcClient({ sendRequest }), vi.fn(), 'codex')
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
    await act(async () => {
      await vi.runAllTimersAsync()
    })

    await expect(result).resolves.toBe(true)
    expect(sendRequest.mock.calls.map((call) => call[1])).toEqual([
      expect.objectContaining({ text: '2', enter: false }),
      expect.objectContaining({ text: '1', enter: false })
    ])
  })

  it('sends a Codex async answer as one ordinary message, not selector keystrokes', async () => {
    const sendRequest = vi.fn().mockResolvedValue(acceptedResponse())
    await mount(stubRpcClient({ sendRequest }), vi.fn(), 'codex')
    const prompt: AskPrompt = {
      replyAsMessage: true,
      questions: [{ question: 'Which color?', multiSelect: false, options: [{ label: 'Red' }] }]
    }

    await expect(answerSend?.answerAsk(prompt, [{ indices: [0] }])).resolves.toBe(true)
    expect(sendRequest.mock.calls.map((call) => call[1])).toEqual([
      expect.objectContaining({ text: '\x1b[200~> Which color?\r\rRed\x1b[201~', enter: true })
    ])
  })

  it('submits a non-selector answer as pasted label text with a single Enter', async () => {
    const sendRequest = vi.fn().mockResolvedValue(acceptedResponse())
    await mount(stubRpcClient({ sendRequest }), vi.fn(), 'grok')

    await expect(answerSend?.answerAsk(TABS_OR_SPACES, [{ indices: [1] }])).resolves.toBe(true)
    expect(sendRequest).toHaveBeenCalledTimes(1)
    expect(sendRequest.mock.calls[0]?.[1]).toMatchObject({ text: 'Spaces', enter: true })
  })

  it('clears an orphaned image paste before an answer that commits with Enter (#10228)', async () => {
    const sendRequest = vi.fn().mockResolvedValue(acceptedResponse())
    await mount(stubRpcClient({ sendRequest }), vi.fn(), 'grok')
    markMobileNativeChatInputStale('terminal')

    await expect(answerSend?.answerAsk(TABS_OR_SPACES, [{ indices: [1] }])).resolves.toBe(true)
    // A stale image path would join the answer without the leading clear.
    expect(sendRequest).toHaveBeenCalledTimes(2)
    expect(sendRequest.mock.calls[0]?.[1]).toMatchObject({ text: '\x15', enter: false })
    expect(sendRequest.mock.calls[1]?.[1]).toMatchObject({ text: 'Spaces', enter: true })
    expect(isMobileNativeChatInputStale('terminal')).toBe(false)
  })

  it('keeps the marker for a selector answer, which cannot submit the composer', async () => {
    const sendRequest = vi.fn().mockResolvedValue(acceptedResponse())
    await mount(stubRpcClient({ sendRequest }), vi.fn(), 'claude')
    markMobileNativeChatInputStale('terminal')

    await expect(answerSend?.answerAsk(TABS_OR_SPACES, [{ indices: [1] }])).resolves.toBe(true)
    // Active overlays swallow clears while acknowledging them; retain the stale marker for the next actual message.
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
    await mount(stubRpcClient({ sendRequest }), onSendError, 'grok')
    markMobileNativeChatInputStale('terminal')

    await expect(answerSend?.answerAsk(TABS_OR_SPACES, [{ indices: [1] }])).resolves.toBe(false)
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
    await mount(stubRpcClient({ sendRequest }), onSendError)

    await expect(answerSend?.answerAsk(TABS_OR_SPACES, [{ indices: [1] }])).resolves.toBe(false)
    expect(sendRequest).toHaveBeenCalledTimes(1)
    expect(onSendError).toHaveBeenCalledWith('Answer not sent')
  })

  it('does not call a budget-truncated multi-question answer a definite non-send', async () => {
    const onSendError = vi.fn()
    const sendRequest = vi.fn(async () => {
      // After the first group lands, budget exhaustion must prevent another write.
      vi.advanceTimersByTime(16_000)
      return acceptedResponse()
    })
    await mount(stubRpcClient({ sendRequest }), onSendError)

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
    await act(async () => {
      await vi.runAllTimersAsync()
    })

    await expect(result).resolves.toBe(false)
    // A partial answer advanced the selector; definite failure would invite an unsafe replay.
    expect(onSendError).toHaveBeenCalledWith('Answer partly sent — check chat before retrying')
  })

  it('reports an ambiguous write as unconfirmed instead of a definite failure', async () => {
    const onSendError = vi.fn()
    const sendRequest = vi
      .fn()
      .mockRejectedValue(markRpcDeliveryUnknown(new Error('Connection closed')))
    await mount(stubRpcClient({ sendRequest }), onSendError)

    await expect(answerSend?.answerAsk(TABS_OR_SPACES, [{ indices: [1] }])).resolves.toBe(false)
    expect(onSendError).toHaveBeenCalledWith('Answer unconfirmed — check chat before retrying')
  })

  it('rejects an empty selection without writing anything', async () => {
    const sendRequest = vi.fn().mockResolvedValue(acceptedResponse())
    await mount(stubRpcClient({ sendRequest }), vi.fn())

    await expect(answerSend?.answerAsk(TABS_OR_SPACES, [{ indices: [] }])).resolves.toBe(false)
    expect(sendRequest).not.toHaveBeenCalled()
  })

  it('cancels delayed keystrokes when the acknowledged input lease is lost', async () => {
    const sendRequest = vi.fn().mockResolvedValue(acceptedResponse())
    await mount(stubRpcClient({ sendRequest }), vi.fn())

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
    await act(async () => {
      await vi.runAllTimersAsync()
    })

    await expect(result).resolves.toBe(false)
    expect(sendRequest).toHaveBeenCalledTimes(1)
  })

  it('rejects an answer while another composed write holds the terminal', async () => {
    const onSendError = vi.fn()
    const sendRequest = vi.fn().mockResolvedValue(acceptedResponse())
    await mount(stubRpcClient({ sendRequest }), onSendError)

    expect(acquireMobileNativeChatTerminalWrite('terminal')).toBe(true)
    await expect(answerSend?.answerAsk(TABS_OR_SPACES, [{ indices: [1] }])).resolves.toBe(false)
    expect(sendRequest).not.toHaveBeenCalled()
    expect(onSendError).toHaveBeenCalledWith('Answer not sent')

    releaseMobileNativeChatTerminalWrite('terminal')
    await expect(answerSend?.answerAsk(TABS_OR_SPACES, [{ indices: [1] }])).resolves.toBe(true)
  })

  it('answers again on the same handle after an earlier answer already landed', async () => {
    const onSendError = vi.fn()
    const sendRequest = vi.fn().mockResolvedValue(acceptedResponse())
    await mount(stubRpcClient({ sendRequest }), onSendError)

    await expect(answerSend?.answerAsk(TABS_OR_SPACES, [{ indices: [0] }])).resolves.toBe(true)
    // A completed chain must vacate its turn slot or all later answers stay fenced.
    await expect(answerSend?.answerAsk(TABS_OR_SPACES, [{ indices: [1] }])).resolves.toBe(true)
    expect(sendRequest).toHaveBeenCalledTimes(2)
    expect(onSendError).not.toHaveBeenCalled()
  })

  it('fences a superseding answer after the cancelled chain moved the selector', async () => {
    const sendRequest = vi.fn().mockResolvedValue(acceptedResponse())
    await mount(stubRpcClient({ sendRequest }), vi.fn())

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
    // The first digit advanced the question; replaying a fresh from-q1 plan would answer the wrong step.
    await act(async () => {
      second = answerSend?.answerAsk(TABS_OR_SPACES, [{ indices: [1] }])
    })
    await act(async () => {
      await vi.runAllTimersAsync()
    })

    await expect(first).resolves.toBe(false)
    await expect(second).resolves.toBe(false)
    expect(sendRequest).toHaveBeenCalledTimes(1)
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
    await mount(stubRpcClient({ sendRequest }), vi.fn())

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
    await mount(stubRpcClient({ sendRequest }), vi.fn())

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

    await expect(first).resolves.toBe(false)
    await expect(second).resolves.toBe(true)
    expect(sendRequest).toHaveBeenCalledTimes(2)
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
    await mount(stubRpcClient({ sendRequest }), onSendError)

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
    // Only the newest chain reports the fence; silence would leave its re-enabled card looking dead.
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
    await mount(stubRpcClient({ sendRequest }), onSendError)

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
    // Lease loss writes no Escape, unlike Stop/cancel, so the prompt can remain retryable.
    await setEnabled(false)
    await act(async () => {
      settle[0]!(acceptedResponse())
      await Promise.resolve()
    })

    expect(sendRequest).toHaveBeenCalledTimes(1)
    await expect(first).resolves.toBe(false)
    await expect(second).resolves.toBe(false)
    // A landed key moved the selector; reporting nothing permits an unsafe double step.
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
    await mount(stubRpcClient({ sendRequest }), vi.fn())

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

    await act(async () => {
      settle[0]!({ ...acceptedResponse(), result: { send: { accepted: false } } })
      await Promise.resolve()
    })
    expect(sendRequest).toHaveBeenCalledTimes(2)
    // The old chain must retain the shared lock while its successor writes or image paste can interleave.
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
    await mount(stubRpcClient({ sendRequest }), onSendError)

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

    await expect(first).resolves.toBe(false)
    await expect(second).resolves.toBe(false)
    expect(onSendError).toHaveBeenCalledWith('Answer not sent — check chat before retrying')
    // Superseded success would clear the successor’s fence banner.
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
    await mount(stubRpcClient({ sendRequest }), onSendError, 'grok')

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

    // Pasted Enter already committed an answer; superseded success would hide the new refusal.
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
    await mount(stubRpcClient({ sendRequest }), onSendError)

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

    // Without a successor, landed keys remain successful; calling them unsent invites a double step.
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
    await mount(stubRpcClient({ sendRequest }), onSendError, 'grok')

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

    // An Enter-committed answer must dismiss its card rather than offer a duplicate submit.
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
    await mount(stubRpcClient({ sendRequest }), onSendError)

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
    // The middle chain sent nothing; inherited ambiguity must still block the third from replaying an advanced selector.
    expect(sendRequest).toHaveBeenCalledTimes(1)
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
    await mount(stubRpcClient({ sendRequest }), vi.fn())

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
      settle[0]!({ ...acceptedResponse(), result: { send: { accepted: false } } })
      await Promise.resolve()
    })
    expect(sendRequest).toHaveBeenCalledTimes(2)

    await act(async () => {
      third = answerSend?.answerAsk(TABS_OR_SPACES, [{ indices: [0] }])
      await Promise.resolve()
      await Promise.resolve()
    })
    // A newer chain must not lose its lock when the earlier one finishes.
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
