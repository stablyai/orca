import { describe, expect, it, vi } from 'vitest'
import type { RpcResponse } from '../transport/types'
import {
  queueTerminalLiveMirrorSend,
  createTerminalLivePendingFlushState
} from './terminal-live-pending-flush-state'
import { sendLiveTerminalInputBytes, type LiveTerminalInputRpc } from './send-live-terminal-input'

function acceptedSend(): RpcResponse {
  return {
    id: 'rpc-1',
    ok: true,
    result: { send: { accepted: true } },
    _meta: { runtimeId: 'runtime-1' }
  }
}

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
} {
  let resolve: (value: T) => void = () => {}
  const promise = new Promise<T>((next) => {
    resolve = next
  })
  return { promise, resolve }
}

describe('send live terminal input bytes', () => {
  it('Given a held RPC response When later deltas queue Then later writes leave before the first response', async () => {
    const streamWrites: string[] = []
    const sendRequest = vi.fn(() => deferred<RpcResponse>().promise)
    const rpc: LiveTerminalInputRpc = {
      sendRequest,
      sendTerminalInput: (_terminal, text) => {
        streamWrites.push(text)
        return 'sent'
      }
    }
    const state = createTerminalLivePendingFlushState()
    const sender = (handle: string, payload: string): Promise<boolean> =>
      sendLiveTerminalInputBytes({
        rpc,
        handle,
        bytes: payload,
        connected: true,
        activeHandle: handle,
        activeSessionTabType: 'terminal',
        deviceToken: 'phone-1'
      })

    const first = queueTerminalLiveMirrorSend(state, 'term-1', 'a', sender)
    await Promise.resolve()
    const second = queueTerminalLiveMirrorSend(state, 'term-1', 'b', sender)
    const third = queueTerminalLiveMirrorSend(state, 'term-1', 'c', sender)
    await Promise.resolve()

    expect(streamWrites.join('')).toBe('abc')
    expect(sendRequest).not.toHaveBeenCalled()
    await expect(Promise.all([first, second, third])).resolves.toEqual([true, true, true])
  })

  it('Given a held RPC response When later deltas queue Then bytes stay in order and none drop', async () => {
    const streamWrites: string[] = []
    const rpc: LiveTerminalInputRpc = {
      sendRequest: vi.fn(),
      sendTerminalInput: (_terminal, text) => {
        streamWrites.push(text)
        return 'sent'
      }
    }
    const state = createTerminalLivePendingFlushState()
    const sender = (handle: string, payload: string): Promise<boolean> =>
      sendLiveTerminalInputBytes({
        rpc,
        handle,
        bytes: payload,
        connected: true,
        activeHandle: handle,
        activeSessionTabType: 'terminal',
        deviceToken: 'phone-1'
      })

    const first = queueTerminalLiveMirrorSend(state, 'term-1', 'h', sender)
    await Promise.resolve()
    const rest = 'ello world'
      .split('')
      .map((letter) => queueTerminalLiveMirrorSend(state, 'term-1', letter, sender))
    await Promise.all([first, ...rest])

    expect(streamWrites.join('')).toBe('hello world')
  })

  it('Given a failed stream write When input is live Then it does not fall back to terminal.send', async () => {
    const sendRequest = vi.fn()
    const rpc: LiveTerminalInputRpc = {
      sendRequest,
      sendTerminalInput: () => 'failed'
    }

    await expect(
      sendLiveTerminalInputBytes({
        rpc,
        handle: 'term-1',
        bytes: 'a',
        connected: true,
        activeHandle: 'term-1',
        activeSessionTabType: 'terminal',
        deviceToken: 'phone-1'
      })
    ).resolves.toBe(false)
    expect(sendRequest).not.toHaveBeenCalled()
  })

  it('Given no stream input When RTT is held Then fallback still coalesces later bytes onto one follow-up RPC', async () => {
    const firstRpc = deferred<RpcResponse>()
    const sendRequest = vi.fn(() => firstRpc.promise)
    const rpc: LiveTerminalInputRpc = { sendRequest }
    const state = createTerminalLivePendingFlushState()
    const sender = (handle: string, payload: string): Promise<boolean> =>
      sendLiveTerminalInputBytes({
        rpc,
        handle,
        bytes: payload,
        connected: true,
        activeHandle: handle,
        activeSessionTabType: 'terminal',
        deviceToken: 'phone-1'
      })

    const first = queueTerminalLiveMirrorSend(state, 'term-1', 'a', sender)
    await Promise.resolve()
    const second = queueTerminalLiveMirrorSend(state, 'term-1', 'b', sender)
    const third = queueTerminalLiveMirrorSend(state, 'term-1', 'c', sender)
    await Promise.resolve()

    expect(sendRequest).toHaveBeenCalledTimes(1)
    expect(sendRequest.mock.calls[0]?.[1]).toMatchObject({ text: 'a' })

    const secondRpc = deferred<RpcResponse>()
    sendRequest.mockImplementationOnce(() => secondRpc.promise)
    firstRpc.resolve(acceptedSend())
    await vi.waitFor(() => expect(sendRequest).toHaveBeenCalledTimes(2))
    expect(sendRequest.mock.calls[1]?.[1]).toMatchObject({ text: 'bc' })
    secondRpc.resolve(acceptedSend())
    await expect(Promise.all([first, second, third])).resolves.toEqual([true, true, true])
  })
})
