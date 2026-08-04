import { createElement, useEffect, useRef } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import { markRpcDeliveryUnknown } from '../transport/rpc-delivery-ambiguity'
import { MOBILE_NATIVE_CHAT_SEND_TIMEOUT_MS } from './mobile-native-chat-send'
import {
  resetMobileNativeChatStopLeasesForTests,
  requestMobileNativeChatWriteLease
} from './mobile-native-chat-stop-lease'
import { resetMobileNativeChatStopCleanupForTests } from './mobile-native-chat-stop-cleanup'
import { useMobileNativeChatStop } from './use-mobile-native-chat-stop'

describe('useMobileNativeChatStop', () => {
  let renderer: ReactTestRenderer | null = null
  let stop: (() => void) | null = null
  const sendRequest = vi.fn()
  const client = { sendRequest } as unknown as RpcClient
  const onSendError = vi.fn()

  beforeEach(() => {
    vi.useFakeTimers()
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    sendRequest.mockReset().mockResolvedValue({
      ok: true,
      result: { send: { accepted: true } }
    })
    onSendError.mockReset()
    resetMobileNativeChatStopLeasesForTests()
    resetMobileNativeChatStopCleanupForTests()
  })

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    stop = null
    vi.useRealTimers()
    resetMobileNativeChatStopLeasesForTests()
    resetMobileNativeChatStopCleanupForTests()
  })

  function Harness({
    enabled,
    streamIdentity,
    agent,
    sessionId
  }: {
    enabled: boolean
    streamIdentity: string
    agent: string
    sessionId: string
  }): null {
    const handleRef = useRef<string | null>('terminal-1')
    const deviceTokenRef = useRef<string | null>('mobile-1')
    const agentRef = useRef<string | null>(agent)
    useEffect(() => {
      agentRef.current = agent
    }, [agent])
    stop = useMobileNativeChatStop({
      client,
      enabled,
      handleRef,
      deviceTokenRef,
      agentRef,
      sessionId,
      streamIdentity,
      cancelPending: vi.fn(),
      onSendError
    })
    return null
  }

  async function render(
    enabled: boolean,
    streamIdentity: string,
    agent = 'claude',
    sessionId = 'session-1'
  ): Promise<void> {
    await act(async () => {
      const element = createElement(Harness, { enabled, streamIdentity, agent, sessionId })
      if (renderer) {
        renderer.update(element)
      } else {
        renderer = create(element)
      }
    })
  }

  it.each([
    ['the acknowledged input lease is lost', false, 'stream-1'],
    ['the active stream changes', true, 'stream-2']
  ])('finishes the captured interrupt when %s', async (_case, enabled, streamIdentity) => {
    await render(true, 'stream-1')

    await act(async () => {
      stop?.()
      await Promise.resolve()
    })
    expect(sendRequest).toHaveBeenCalledTimes(1)

    await render(enabled as boolean, streamIdentity as string)
    await act(async () => vi.runAllTimersAsync())

    expect(sendRequest).toHaveBeenCalledTimes(2)
  })

  it('handles a rejected Escape without leaking an unhandled rejection', async () => {
    sendRequest.mockRejectedValue(new Error('disconnected'))
    await render(true, 'stream-1')

    await act(async () => {
      stop?.()
      await Promise.resolve()
    })
    await act(async () => {
      await Promise.resolve()
      await vi.runAllTimersAsync()
    })

    expect(onSendError).toHaveBeenCalledOnce()
    expect(onSendError).toHaveBeenCalledWith('Stop not sent')
  })

  it.each([
    ['RPC failure', { ok: false, error: { code: 'stale', message: 'stale' } }],
    ['non-accepted send', { ok: true, result: { send: { accepted: false } } }]
  ])('reports Stop not sent after a resolved %s', async (_case, response) => {
    sendRequest.mockResolvedValue(response)
    await render(true, 'stream-1')

    act(() => stop?.())
    await act(async () => vi.runAllTimersAsync())

    expect(onSendError).toHaveBeenCalledOnce()
    expect(onSendError).toHaveBeenCalledWith('Stop not sent')
  })

  it.each([
    [
      'an ack lost after the frame was written',
      () => markRpcDeliveryUnknown(new Error('rpc timeout'))
    ],
    ['a logical client cutover', () => new Error('RPC interrupted by connection migration')]
  ])('reports Stop as unconfirmed after %s', async (_case, makeError) => {
    sendRequest.mockRejectedValue(makeError())
    await render(true, 'stream-1')

    act(() => stop?.())
    await act(async () => {
      await Promise.resolve()
      await vi.runAllTimersAsync()
    })

    // The Escape may have landed; a definite "not sent" invites a second Escape.
    expect(onSendError).toHaveBeenCalledOnce()
    expect(onSendError).toHaveBeenCalledWith('Stop unconfirmed — check chat before retrying')
  })

  it.each([
    ['second', 0],
    ['first', 1]
  ])('stays quiet when the %s Escape fails after its sibling landed', async (_case, failIndex) => {
    let call = 0
    sendRequest.mockImplementation(() => {
      const index = call
      call += 1
      return index === failIndex
        ? Promise.reject(markRpcDeliveryUnknown(new Error('rpc timeout')))
        : Promise.resolve({ ok: true, result: { send: { accepted: true } } })
    })
    await render(true, 'stream-1')

    act(() => stop?.())
    await act(async () => {
      await Promise.resolve()
      await vi.runAllTimersAsync()
    })

    // Two paced Escapes are one user action: either landing means the agent stopped,
    // so a straggler's failure must not tell the user to press Stop again.
    expect(sendRequest).toHaveBeenCalledTimes(2)
    expect(onSendError).not.toHaveBeenCalled()
  })

  it('bounds the Escape on a reconnect wait instead of parking forever', async () => {
    await render(true, 'stream-1')

    await act(async () => {
      stop?.()
      await Promise.resolve()
    })

    // The budget covers the reconnect wait too, so a stop can't outlast its ceiling.
    expect(sendRequest).toHaveBeenCalledWith(
      'terminal.send',
      expect.anything(),
      expect.objectContaining({
        timeoutMs: MOBILE_NATIVE_CHAT_SEND_TIMEOUT_MS,
        budgetSpansConnect: true
      })
    )
  })

  it('stops acknowledged Codex background tools without closing the reusable session', async () => {
    let backgroundToolRunning = true
    let sessionRunning = true
    sendRequest.mockImplementation((method: string, params: { text?: string; enter?: boolean }) => {
      if (method === 'terminal.stop') {
        sessionRunning = false
      }
      if (params.text === '/stop' && params.enter === true) {
        backgroundToolRunning = false
      }
      return Promise.resolve({ ok: true, result: { send: { accepted: true } } })
    })
    await render(true, 'stream-1', 'codex')

    act(() => stop?.())
    await act(async () => vi.runAllTimersAsync())

    expect(sendRequest.mock.calls.map(([method]) => method)).toEqual([
      'terminal.send',
      'terminal.send',
      'terminal.send'
    ])
    expect(sendRequest.mock.calls.map(([, params]) => params)).toEqual([
      expect.objectContaining({ text: '\x1b', enter: false }),
      expect.objectContaining({ text: '\x1b', enter: false }),
      expect.objectContaining({ text: '/stop', enter: true })
    ])
    expect(backgroundToolRunning).toBe(false)
    expect(sessionRunning).toBe(true)
  })

  it('leaves non-Codex Stop on the existing paced Escape path', async () => {
    await render(true, 'stream-1', 'claude')

    act(() => stop?.())
    await act(async () => vi.runAllTimersAsync())

    expect(sendRequest).toHaveBeenCalledTimes(2)
    expect(sendRequest.mock.calls.every(([, params]) => params.text === '\x1b')).toBe(true)
  })

  it('cancels Codex cleanup when the active agent changes after the interrupt', async () => {
    await render(true, 'stream-1', 'codex')

    act(() => stop?.())
    await act(async () => vi.advanceTimersByTimeAsync(80))
    expect(sendRequest).toHaveBeenCalledTimes(2)

    await render(true, 'stream-1', 'claude')
    await act(async () => vi.runAllTimersAsync())

    expect(sendRequest).toHaveBeenCalledTimes(2)
  })

  it('finishes Codex cleanup against the captured terminal after a route change', async () => {
    await render(true, 'stream-1', 'codex')

    act(() => stop?.())
    await act(async () => vi.advanceTimersByTimeAsync(80))
    await render(true, 'stream-2', 'codex')
    await act(async () => vi.runAllTimersAsync())

    expect(sendRequest.mock.calls.map(([, params]) => params.text)).toEqual([
      '\x1b',
      '\x1b',
      '/stop'
    ])
  })

  it('finishes Codex cleanup when the original route disconnects after the interrupt', async () => {
    await render(true, 'stream-1', 'codex')

    act(() => stop?.())
    await act(async () => vi.advanceTimersByTimeAsync(80))
    await render(false, 'stream-1', 'codex')
    await act(async () => vi.runAllTimersAsync())

    expect(sendRequest.mock.calls.at(-1)?.[1]).toMatchObject({ text: '/stop', enter: true })
  })

  it('finishes Codex cleanup after the chat unmounts', async () => {
    await render(true, 'stream-1', 'codex')

    act(() => stop?.())
    await act(async () => vi.advanceTimersByTimeAsync(80))
    act(() => renderer?.unmount())
    renderer = null
    await act(async () => vi.runAllTimersAsync())

    expect(sendRequest.mock.calls.at(-1)?.[1]).toMatchObject({ text: '/stop', enter: true })
    expect(onSendError).not.toHaveBeenCalled()
  })

  it('defers accepted-Escape cleanup out of a replacement session', async () => {
    await render(true, 'stream-1', 'codex', 'session-1')

    await act(async () => {
      stop?.()
      await Promise.resolve()
    })
    await render(true, 'stream-2', 'codex', 'session-2')
    await act(async () => vi.runAllTimersAsync())

    expect(sendRequest).toHaveBeenCalledTimes(1)
    expect(sendRequest.mock.calls.some(([, params]) => params.text === '/stop')).toBe(false)
    expect(onSendError).not.toHaveBeenCalled()

    await render(true, 'stream-1', 'codex', 'session-1')
    await act(() => Promise.resolve())
    expect(sendRequest.mock.calls.filter(([, params]) => params.text === '/stop')).toHaveLength(1)
  })

  it('recovers definitely rejected cleanup when the original session reconnects', async () => {
    sendRequest.mockImplementation((_method: string, params: { text?: string }) =>
      Promise.resolve({
        ok: true,
        result: { send: { accepted: params.text !== '/stop' } }
      })
    )
    await render(true, 'stream-1', 'codex')

    act(() => stop?.())
    await act(async () => vi.runAllTimersAsync())
    expect(sendRequest.mock.calls.filter(([, params]) => params.text === '/stop')).toHaveLength(1)

    sendRequest.mockResolvedValue({ ok: true, result: { send: { accepted: true } } })
    await render(false, 'stream-1', 'codex')
    await render(true, 'stream-1', 'codex')
    await act(() => Promise.resolve())

    expect(sendRequest.mock.calls.filter(([, params]) => params.text === '/stop')).toHaveLength(2)
    expect(sendRequest.mock.calls.filter(([, params]) => params.text === '\x1b')).toHaveLength(2)
  })

  it('defers queued recovery instead of cleaning up a replacement session', async () => {
    sendRequest.mockImplementation((_method: string, params: { text?: string }) =>
      Promise.resolve({
        ok: true,
        result: { send: { accepted: params.text !== '/stop' } }
      })
    )
    await render(true, 'stream-1', 'codex', 'session-1')
    act(() => stop?.())
    await act(async () => vi.runAllTimersAsync())
    await render(false, 'stream-1', 'codex', 'session-1')

    const writer = await requestMobileNativeChatWriteLease('terminal-1').acquired
    sendRequest.mockResolvedValue({ ok: true, result: { send: { accepted: true } } })
    await render(true, 'stream-1', 'codex', 'session-1')
    await render(true, 'stream-2', 'codex', 'session-2')
    writer?.release()
    await act(() => Promise.resolve())

    expect(sendRequest.mock.calls.filter(([, params]) => params.text === '/stop')).toHaveLength(1)
    await render(true, 'stream-1', 'codex', 'session-1')
    await act(() => Promise.resolve())
    expect(sendRequest.mock.calls.filter(([, params]) => params.text === '/stop')).toHaveLength(2)
  })

  it('reports an acknowledged interrupt whose Codex tool cleanup is rejected', async () => {
    sendRequest.mockImplementation((_method: string, params: { text?: string }) =>
      Promise.resolve({
        ok: true,
        result: { send: { accepted: params.text !== '/stop' } }
      })
    )
    await render(true, 'stream-1', 'codex')

    act(() => stop?.())
    await act(async () => vi.runAllTimersAsync())

    expect(onSendError).toHaveBeenCalledOnce()
    expect(onSendError).toHaveBeenCalledWith(
      'Agent interrupted; background cleanup pending — reconnect or return to this chat to retry'
    )
  })

  it('describes an ambiguous Codex cleanup without questioning the accepted interrupt', async () => {
    sendRequest.mockImplementation((_method: string, params: { text?: string }) =>
      params.text === '/stop'
        ? Promise.reject(markRpcDeliveryUnknown(new Error('rpc timeout')))
        : Promise.resolve({ ok: true, result: { send: { accepted: true } } })
    )
    await render(true, 'stream-1', 'codex')

    act(() => stop?.())
    await act(async () => vi.runAllTimersAsync())

    expect(onSendError).toHaveBeenCalledWith(
      'Agent interrupted; background cleanup unconfirmed — check chat before retrying'
    )
  })

  it('ignores duplicate Stop taps and runs Codex cleanup exactly once', async () => {
    await render(true, 'stream-1', 'codex')

    act(() => {
      stop?.()
      stop?.()
      stop?.()
    })
    await act(async () => vi.runAllTimersAsync())

    expect(sendRequest).toHaveBeenCalledTimes(3)
    expect(sendRequest.mock.calls.filter(([, params]) => params.text === '/stop')).toHaveLength(1)
  })

  it.each([
    ['first', 0],
    ['second', 1]
  ])(
    'runs Codex cleanup once when only the %s Escape is accepted',
    async (_case, acceptedIndex) => {
      let escapeIndex = 0
      sendRequest.mockImplementation((_method: string, params: { text?: string }) => {
        const accepted = params.text === '/stop' || escapeIndex === acceptedIndex
        if (params.text !== '/stop') {
          escapeIndex += 1
        }
        return Promise.resolve({ ok: true, result: { send: { accepted } } })
      })
      await render(true, 'stream-1', 'codex')

      act(() => stop?.())
      await act(async () => vi.runAllTimersAsync())

      expect(sendRequest.mock.calls.filter(([, params]) => params.text === '/stop')).toHaveLength(1)
      expect(onSendError).not.toHaveBeenCalled()
    }
  )

  it('gives cleanup a fresh budget after slow accepted Escape acknowledgements', async () => {
    sendRequest.mockImplementation((_method: string, params: { text?: string }) => {
      const response = { ok: true, result: { send: { accepted: true } } }
      return params.text === '\x1b'
        ? new Promise((resolve) => setTimeout(() => resolve(response), 13_500))
        : Promise.resolve(response)
    })
    await render(true, 'stream-1', 'codex')

    act(() => stop?.())
    await act(async () => vi.runAllTimersAsync())

    expect(sendRequest).toHaveBeenCalledTimes(3)
    expect(sendRequest.mock.calls[2]?.[1]).toMatchObject({ text: '/stop', enter: true })
    expect(sendRequest.mock.calls[2]?.[2]).toMatchObject({
      timeoutMs: MOBILE_NATIVE_CHAT_SEND_TIMEOUT_MS,
      budgetSpansConnect: true
    })
  })

  it('releases queued writers after an Escape failure', async () => {
    sendRequest.mockResolvedValue({ ok: true, result: { send: { accepted: false } } })
    await render(true, 'stream-1')
    const released = vi.fn()

    act(() => stop?.())
    void requestMobileNativeChatWriteLease('terminal-1').acquired.then((lease) => {
      released()
      lease?.release()
    })
    await act(async () => vi.runAllTimersAsync())

    expect(released).toHaveBeenCalledOnce()
  })

  it('holds the lease through an in-flight Escape after unmount, then releases it', async () => {
    let resolveEscape!: (value: unknown) => void
    sendRequest.mockReturnValue(
      new Promise((resolve) => {
        resolveEscape = resolve
      })
    )
    await render(true, 'stream-1')
    const released = vi.fn()

    act(() => stop?.())
    void requestMobileNativeChatWriteLease('terminal-1').acquired.then((lease) => {
      released()
      lease?.release()
    })
    act(() => renderer?.unmount())
    renderer = null
    await Promise.resolve()
    expect(released).not.toHaveBeenCalled()

    await act(async () => {
      resolveEscape({ ok: true, result: { send: { accepted: true } } })
      await vi.runAllTimersAsync()
    })
    expect(released).toHaveBeenCalledOnce()
  })
})
