import { afterEach, describe, expect, it, vi } from 'vitest'
import { RelayDispatcher } from './dispatcher'
import { encodeJsonRpcFrame, MessageType, type JsonRpcResponse } from './protocol'
import {
  TERMINAL_UNAVAILABLE_RPC_ERROR_CODE,
  type TerminalUnavailableCause
} from '../shared/terminal-unavailable-cause'

function decodeResponse(frame: Buffer): JsonRpcResponse | null {
  if (frame[0] !== MessageType.Regular) {
    return null
  }
  const length = frame.readUInt32BE(9)
  return JSON.parse(frame.subarray(13, 13 + length).toString('utf8')) as JsonRpcResponse
}

describe('RelayDispatcher structured errors', () => {
  const dispatchers: RelayDispatcher[] = []

  afterEach(() => {
    dispatchers.splice(0).forEach((dispatcher) => dispatcher.dispose())
    vi.useRealTimers()
  })

  it('preserves validated skill failure data without publishing nonnumeric JSON-RPC codes', async () => {
    vi.useFakeTimers()
    const written: Buffer[] = []
    const dispatcher = new RelayDispatcher((data) => {
      written.push(Buffer.from(data))
    })
    dispatchers.push(dispatcher)
    const data = {
      category: 'archive',
      code: 'skill-package-archive-invalid',
      retryable: false
    }
    dispatcher.onRequest('fail.structured', async () => {
      throw Object.assign(new Error(data.code), { code: 'skill_install_failure', data })
    })
    dispatcher.onRequest('fail.private', async () => {
      throw Object.assign(new Error('boom'), { data: { secret: 'do-not-publish' } })
    })

    dispatcher.feed(encodeJsonRpcFrame({ jsonrpc: '2.0', id: 6, method: 'fail.structured' }, 1, 0))
    dispatcher.feed(encodeJsonRpcFrame({ jsonrpc: '2.0', id: 7, method: 'fail.private' }, 2, 0))
    await vi.advanceTimersByTimeAsync(0)

    const responses = written.map(decodeResponse)
    expect(responses.find((message) => message?.id === 6)?.error).toEqual({
      code: -32000,
      message: data.code,
      data
    })
    expect(responses.find((message) => message?.id === 7)?.error).toEqual({
      code: -32000,
      message: 'boom'
    })
  })

  it('carries a terminal-unavailable cause across the wire, and rejects a malformed one', async () => {
    // Why this must cross: the fault is proved on the relay at spawn time, and the only
    // machinery that can repair it runs on the client. Prose cannot be acted on.
    vi.useFakeTimers()
    const written: Buffer[] = []
    const dispatcher = new RelayDispatcher((data) => {
      written.push(Buffer.from(data))
    })
    dispatchers.push(dispatcher)
    const cause: TerminalUnavailableCause = {
      status: 'blocked',
      reason: 'abi_mismatch',
      detail: 'built for Node ABI 127, this host runs ABI 115',
      repairable: true,
      host: {
        platform: 'linux',
        arch: 'x64',
        libc: 'glibc',
        glibcVersion: '2.31',
        nodeAbi: '115',
        nodeVersion: 'v20.11.0'
      }
    }
    dispatcher.onRequest('pty.spawn', async () => {
      throw Object.assign(new Error('Remote terminals are unavailable'), {
        code: TERMINAL_UNAVAILABLE_RPC_ERROR_CODE,
        data: cause
      })
    })
    dispatcher.onRequest('pty.spawnBogus', async () => {
      throw Object.assign(new Error('Remote terminals are unavailable'), {
        code: TERMINAL_UNAVAILABLE_RPC_ERROR_CODE,
        data: { status: 'blocked', repairable: true }
      })
    })

    dispatcher.feed(encodeJsonRpcFrame({ jsonrpc: '2.0', id: 8, method: 'pty.spawn' }, 1, 0))
    dispatcher.feed(encodeJsonRpcFrame({ jsonrpc: '2.0', id: 9, method: 'pty.spawnBogus' }, 2, 0))
    await vi.advanceTimersByTimeAsync(0)

    const responses = written.map(decodeResponse)
    expect(responses.find((message) => message?.id === 8)?.error?.data).toEqual(cause)
    // A cause that does not validate is dropped entirely; a half-read cause must never
    // authorize a repair.
    expect(responses.find((message) => message?.id === 9)?.error).toEqual({
      code: -32000,
      message: 'Remote terminals are unavailable'
    })
  })
})
