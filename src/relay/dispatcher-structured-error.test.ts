import { afterEach, describe, expect, it, vi } from 'vitest'
import { SKILL_INSTALL_RPC_ERROR_CODE } from '../shared/skill-install-failure'
import { RelayDispatcher } from './dispatcher'
import { encodeJsonRpcFrame, MessageType, type JsonRpcResponse } from './protocol'

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
    dispatcher.onRequest('fail.enoent', async () => {
      throw Object.assign(new Error('missing'), { code: 'ENOENT' })
    })
    dispatcher.onRequest('fail.eacces', async () => {
      throw Object.assign(new Error('denied'), { code: 'EACCES' })
    })
    dispatcher.onRequest('fail.invalid-skill', async () => {
      throw Object.assign(new Error('invalid skill failure'), {
        code: SKILL_INSTALL_RPC_ERROR_CODE,
        data: { secret: 'do-not-publish' }
      })
    })

    dispatcher.feed(encodeJsonRpcFrame({ jsonrpc: '2.0', id: 6, method: 'fail.structured' }, 1, 0))
    dispatcher.feed(encodeJsonRpcFrame({ jsonrpc: '2.0', id: 7, method: 'fail.private' }, 2, 0))
    dispatcher.feed(encodeJsonRpcFrame({ jsonrpc: '2.0', id: 8, method: 'fail.enoent' }, 3, 0))
    dispatcher.feed(encodeJsonRpcFrame({ jsonrpc: '2.0', id: 9, method: 'fail.eacces' }, 4, 0))
    dispatcher.feed(
      encodeJsonRpcFrame({ jsonrpc: '2.0', id: 10, method: 'fail.invalid-skill' }, 5, 0)
    )
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
    expect(responses.find((message) => message?.id === 8)?.error).toEqual({
      code: -32000,
      message: 'missing',
      data: { errno: 'ENOENT' }
    })
    expect(responses.find((message) => message?.id === 9)?.error).toEqual({
      code: -32000,
      message: 'denied',
      data: { errno: 'EACCES' }
    })
    expect(responses.find((message) => message?.id === 10)?.error).toEqual({
      code: -32000,
      message: 'invalid skill failure'
    })
  })
})
