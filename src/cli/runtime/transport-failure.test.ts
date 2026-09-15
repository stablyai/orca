import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { sendRequest } from './transport'
import { formatCliError } from '../cli-error'

const { createConnection } = vi.hoisted(() => ({ createConnection: vi.fn() }))
vi.mock('node:net', () => ({ createConnection }))
vi.mock('node:crypto', () => ({ randomUUID: () => 'request-1' }))
const metadata = {
  runtimeId: 'runtime-1',
  pid: 42,
  startedAt: 1,
  authToken: 'synthetic-fixture',
  transports: [{ kind: 'named-pipe' as const, endpoint: 'synthetic-endpoint' }]
}
class TestSocket extends EventEmitter {
  setEncoding = vi.fn()
  write = vi.fn()
  end = vi.fn()
  destroy = vi.fn()
}
let socket: TestSocket
beforeEach(() => {
  socket = new TestSocket()
  createConnection.mockReturnValue(socket)
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('transport failure capture', () => {
  it.each(['EPERM', 'EACCES', 'ECONNREFUSED', 'ENOENT'])(
    'retains native %s without endpoint or message',
    async (code) => {
      const pending = sendRequest(metadata, 'status.get', undefined, 1000)
      socket.emit(
        'error',
        Object.assign(new Error('private-fixture'), {
          code,
          errno: -4048,
          syscall: 'connect',
          address: 'private-fixture',
          path: 'private-fixture'
        })
      )
      const error = await pending.catch((e: unknown) => e)
      expect(error).toMatchObject({
        code: 'runtime_unavailable',
        data: {
          transportFailure: {
            outcome: 'socket_error',
            code,
            errno: -4048,
            syscall: 'connect',
            connected: false
          }
        }
      })
      expect(JSON.stringify(error)).not.toContain('private-fixture')
      expect(formatCliError(error)).not.toMatch(/not running|orca open|Restart Orca/)
      expect(socket.end).toHaveBeenCalledOnce()
    }
  )
  it('records connection establishment before a later socket error', async () => {
    const pending = sendRequest(metadata, 'status.get', undefined, 1000)
    socket.emit('connect')
    socket.emit('error', { code: 'ECONNREFUSED' })
    await expect(pending).rejects.toMatchObject({
      data: { transportFailure: { outcome: 'socket_error', connected: true } }
    })
  })
  it('rejects arbitrary diagnostic text', async () => {
    const pending = sendRequest(metadata, 'status.get', undefined, 1000)
    socket.emit('error', {
      code: 'sensitive/path',
      errno: 'sensitive-value',
      syscall: 'connect sensitive/path'
    })
    await expect(pending).rejects.toMatchObject({
      data: { transportFailure: { outcome: 'socket_error' } }
    })
    const error = await pending.catch((e: unknown) => e)
    expect(JSON.stringify(error)).not.toContain('sensitive')
  })
  it('captures early close before the deadline', async () => {
    const pending = sendRequest(metadata, 'status.get', undefined, 1000)
    socket.emit('close')
    await expect(pending).rejects.toMatchObject({
      code: 'runtime_unavailable',
      data: { transportFailure: { outcome: 'closed' } }
    })
  })
  it('captures a finite timeout and destroys its socket', async () => {
    vi.useFakeTimers()
    const pending = expect(
      sendRequest(metadata, 'status.get', undefined, 20)
    ).rejects.toMatchObject({
      code: 'runtime_timeout',
      data: { transportFailure: { outcome: 'timeout' } }
    })
    await vi.advanceTimersByTimeAsync(20)
    await pending
    expect(socket.destroy).toHaveBeenCalledOnce()
  })
  it.each([
    'invalid-json\n',
    '{}\n',
    `${JSON.stringify({
      id: 'wrong-id',
      ok: true,
      result: {},
      _meta: { runtimeId: 'runtime-1' }
    })}\n`
  ])('captures invalid frame %s', async (frame) => {
    const pending = sendRequest(metadata, 'status.get', undefined, 1000)
    socket.emit('data', frame)
    await expect(pending).rejects.toMatchObject({
      code: 'invalid_runtime_response',
      data: { transportFailure: { outcome: 'invalid_response' } }
    })
  })
  it('rejects a reused endpoint with a different runtime identity', async () => {
    const pending = sendRequest(metadata, 'status.get', undefined, 1000)
    socket.emit(
      'data',
      `${JSON.stringify({
        id: 'request-1',
        ok: true,
        result: {},
        _meta: { runtimeId: 'runtime-new' }
      })}\n`
    )
    await expect(pending).rejects.toMatchObject({
      code: 'runtime_unavailable',
      data: { transportFailure: { outcome: 'identity_changed' } }
    })
  })
})
