import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentType } from '../../../src/shared/native-chat-types'
import type { RpcClient } from '../transport/rpc-client'
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

  it('paces every accepted Claude step and resolves true after the final Enter', async () => {
    const sendRequest = vi.fn().mockResolvedValue(acceptedResponse())
    await mount({ sendRequest } as unknown as RpcClient, vi.fn())

    let result: Promise<boolean> | undefined
    await act(async () => {
      result = answerSend?.answerAsk('first\nsecond')
    })
    expect(sendRequest).toHaveBeenCalledTimes(1)
    expect(sendRequest.mock.calls[0]?.[1]).toMatchObject({ text: 'first', enter: false })

    await act(async () => vi.advanceTimersByTimeAsync(500))
    expect(sendRequest.mock.calls[1]?.[1]).toMatchObject({ text: '', enter: true })
    await act(async () => vi.advanceTimersByTimeAsync(300))
    expect(sendRequest.mock.calls[2]?.[1]).toMatchObject({ text: 'second', enter: false })
    await act(async () => vi.advanceTimersByTimeAsync(500))
    await expect(result).resolves.toBe(true)
    expect(sendRequest.mock.calls[3]?.[1]).toMatchObject({ text: '', enter: true })
  })

  it('paces OpenClaude Ask answers with Claude transcript semantics', async () => {
    const sendRequest = vi.fn().mockResolvedValue(acceptedResponse())
    await mount({ sendRequest } as unknown as RpcClient, vi.fn(), 'openclaude')

    let result: Promise<boolean> | undefined
    await act(async () => {
      result = answerSend?.answerAsk('first\nsecond')
    })
    await act(async () => vi.runAllTimersAsync())

    await expect(result).resolves.toBe(true)
    expect(sendRequest.mock.calls.map((call) => call[1])).toEqual([
      expect.objectContaining({ text: 'first', enter: false }),
      expect.objectContaining({ text: '', enter: true }),
      expect.objectContaining({ text: 'second', enter: false }),
      expect.objectContaining({ text: '', enter: true })
    ])
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

    await expect(answerSend?.answerAsk('first\nsecond')).resolves.toBe(false)
    expect(sendRequest).toHaveBeenCalledTimes(1)
    expect(onSendError).toHaveBeenCalledWith('Answer not sent')
  })

  it('cancels delayed Ask writes when the acknowledged input lease is lost', async () => {
    const sendRequest = vi.fn().mockResolvedValue(acceptedResponse())
    await mount({ sendRequest } as unknown as RpcClient, vi.fn())

    let result: Promise<boolean> | undefined
    await act(async () => {
      result = answerSend?.answerAsk('first\nsecond')
    })
    expect(sendRequest).toHaveBeenCalledTimes(1)

    await setEnabled(false)
    await act(async () => vi.runAllTimersAsync())

    await expect(result).resolves.toBe(false)
    expect(sendRequest).toHaveBeenCalledTimes(1)
  })
})
