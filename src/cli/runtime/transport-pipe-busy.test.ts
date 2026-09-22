import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { createConnectionMock } = vi.hoisted(() => ({ createConnectionMock: vi.fn() }))
vi.mock('node:net', () => ({ createConnection: createConnectionMock }))

import type { RuntimeMetadata } from '../../shared/runtime-bootstrap'
import { sendRequest } from './transport'

class FakeSocket extends EventEmitter {
  writes: string[] = []

  setEncoding(): this {
    return this
  }

  write(value: string): boolean {
    this.writes.push(value)
    return true
  }

  end(): this {
    return this
  }

  destroy(): this {
    return this
  }
}

const metadata: RuntimeMetadata = {
  runtimeId: 'runtime-pipe-busy',
  pid: 123,
  transports: [{ kind: 'named-pipe', endpoint: String.raw`\\.\pipe\orca-test` }],
  authToken: 'test-capability',
  startedAt: 1
}

function error(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code, errno: -4082, syscall: 'connect' })
}

beforeEach(() => {
  createConnectionMock.mockReset()
  vi.useRealTimers()
})

describe('named-pipe busy handling', () => {
  it('retries EBUSY only before sending and executes the operation once', async () => {
    vi.useFakeTimers()
    const busy = new FakeSocket()
    const connected = new FakeSocket()
    createConnectionMock.mockReturnValueOnce(busy).mockReturnValueOnce(connected)

    const responsePromise = sendRequest<{ count: number }>(metadata, 'test.increment', {}, 1000)
    busy.emit('error', error('EBUSY'))
    await vi.advanceTimersByTimeAsync(25)
    connected.emit('connect')
    const request = JSON.parse(connected.writes[0]) as { id: string }
    connected.emit(
      'data',
      `${JSON.stringify({
        id: request.id,
        ok: true,
        result: { count: 1 },
        _meta: { runtimeId: metadata.runtimeId }
      })}\n`
    )

    await expect(responsePromise).resolves.toMatchObject({ result: { count: 1 } })
    expect(createConnectionMock).toHaveBeenCalledTimes(2)
    expect(busy.writes).toHaveLength(0)
    expect(connected.writes).toHaveLength(1)
  })

  it('keeps all progressive retries inside the original deadline', async () => {
    vi.useFakeTimers()
    createConnectionMock.mockImplementation(() => {
      const socket = new FakeSocket()
      queueMicrotask(() => socket.emit('error', error('EBUSY')))
      return socket
    })

    const responsePromise = sendRequest(metadata, 'test.never-sent', {}, 100)
    const rejection = expect(responsePromise).rejects.toMatchObject({ code: 'runtime_timeout' })
    await vi.advanceTimersByTimeAsync(100)
    await rejection
    expect(createConnectionMock.mock.calls.length).toBeGreaterThan(1)
    expect(createConnectionMock.mock.results.every(({ value }) => value.writes.length === 0)).toBe(
      true
    )
  })

  it('writes nothing when connect arrives after the original deadline', async () => {
    vi.useFakeTimers()
    const socket = new FakeSocket()
    createConnectionMock.mockReturnValue(socket)
    const responsePromise = sendRequest(metadata, 'test.never-sent', {}, 100)
    const rejection = expect(responsePromise).rejects.toMatchObject({ code: 'runtime_timeout' })

    await vi.advanceTimersByTimeAsync(100)
    await rejection
    socket.emit('connect')
    expect(socket.writes).toHaveLength(0)
  })

  it('writes nothing when an EBUSY-retired attempt connects late', async () => {
    vi.useFakeTimers()
    const retired = new FakeSocket()
    const replacement = new FakeSocket()
    createConnectionMock.mockReturnValueOnce(retired).mockReturnValueOnce(replacement)
    const responsePromise = sendRequest<{ count: number }>(metadata, 'test.increment', {}, 1000)

    retired.emit('error', error('EBUSY'))
    retired.emit('connect')
    expect(retired.writes).toHaveLength(0)

    await vi.advanceTimersByTimeAsync(25)
    replacement.emit('connect')
    const request = JSON.parse(replacement.writes[0]) as { id: string }
    replacement.emit(
      'data',
      `${JSON.stringify({
        id: request.id,
        ok: true,
        result: { count: 1 },
        _meta: { runtimeId: metadata.runtimeId }
      })}\n`
    )
    await expect(responsePromise).resolves.toMatchObject({ result: { count: 1 } })
    expect(replacement.writes).toHaveLength(1)
  })

  it('preserves a non-busy connection error without retrying', async () => {
    const socket = new FakeSocket()
    createConnectionMock.mockReturnValue(socket)
    const responsePromise = sendRequest(metadata, 'test.never-sent', {}, 1000)
    socket.emit('error', error('ECONNREFUSED'))

    await expect(responsePromise).rejects.toMatchObject({
      code: 'runtime_unavailable',
      data: {
        connectionError: { code: 'ECONNREFUSED', errno: -4082, syscall: 'connect' }
      }
    })
    expect(createConnectionMock).toHaveBeenCalledTimes(1)
  })

  it('does not replay after the request has been handed to the socket', async () => {
    const socket = new FakeSocket()
    createConnectionMock.mockReturnValue(socket)
    const responsePromise = sendRequest(metadata, 'test.increment', {}, 1000)
    socket.emit('connect')
    socket.emit('error', error('EBUSY'))

    await expect(responsePromise).rejects.toMatchObject({
      code: 'runtime_unavailable',
      data: { connectionError: { code: 'EBUSY' } }
    })
    expect(createConnectionMock).toHaveBeenCalledTimes(1)
    expect(socket.writes).toHaveLength(1)
  })
})
