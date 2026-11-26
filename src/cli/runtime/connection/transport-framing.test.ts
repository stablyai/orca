import '../../../shared/remote-runtime/host-store/environment-store-worker-test-fixture'
import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeMetadata } from '../../../shared/remote-runtime/bootstrap/runtime-bootstrap'
import { sendRequest } from './transport'

const { createConnection } = vi.hoisted(() => ({ createConnection: vi.fn() }))
vi.mock('node:net', () => ({ createConnection }))
vi.mock('node:crypto', () => ({ randomUUID: () => 'request-1' }))

const metadata: RuntimeMetadata = {
  runtimeId: 'runtime-1',
  pid: 123,
  transports: [{ kind: 'unix', endpoint: 'test-only' }],
  authToken: 'token',
  startedAt: 1
}
const reply = (result: unknown) =>
  `${JSON.stringify({ id: 'request-1', ok: true, result, _meta: { runtimeId: 'runtime-1' } })}\n`

class TestSocket extends EventEmitter {
  setEncoding = (): void => {}
  write = (): void => {}
  end = (): void => {}
  destroy = (): void => {}
}
let socket: TestSocket

beforeEach(() => {
  socket = new TestSocket()
  createConnection.mockReturnValue(socket)
})
afterEach(() => {
  vi.useRealTimers()
})

describe('CLI runtime response framing', () => {
  it('refreshes keepalives across chunks and ignores blanks and data after the final frame', async () => {
    vi.useFakeTimers()
    const pending = sendRequest(metadata, 'terminal.read', {}, 100)
    await vi.advanceTimersByTimeAsync(90)
    socket.emit('data', ' \r\n{"_keep')
    socket.emit('data', 'alive":true}\n\t\n')
    await vi.advanceTimersByTimeAsync(90)
    socket.emit('data', `${reply({ data: 'done' })}invalid JSON\n`)
    socket.emit('data', 'more ignored data')
    await expect(pending).resolves.toMatchObject({ result: { data: 'done' } })
  })

  it.each([
    ['broken JSON\n', 'invalid_runtime_response'],
    ['{"id":"other","ok":true,"result":{}}\n', 'invalid_runtime_response'],
    [
      '{"id":"request-1","ok":true,"result":{},"_meta":{"runtimeId":"other"}}\n',
      'runtime_unavailable'
    ]
  ])(
    'rejects a fragmented invalid first frame before subsequent valid frames',
    async (line, code) => {
      const pending = sendRequest(metadata, 'terminal.read', {}, 30000)
      socket.emit('data', line.slice(0, 2))
      socket.emit('data', line.slice(2) + reply({ data: 'ignored' }))
      await expect(pending).rejects.toMatchObject({ code })
    }
  )

  it('marks a timeout before the request is written as never sent', async () => {
    vi.useFakeTimers()
    const settled = sendRequest(metadata, 'orchestration.send', {}, 100).then(
      () => undefined,
      (error: unknown) => error
    )
    // The socket never connects, so nothing was written.
    await vi.advanceTimersByTimeAsync(100)
    expect(await settled).toMatchObject({ code: 'runtime_timeout', data: { requestSent: false } })
  })

  it('leaves a timeout after the request is written as possibly delivered', async () => {
    vi.useFakeTimers()
    const write = vi.spyOn(socket, 'write')
    const pending = sendRequest(metadata, 'orchestration.send', {}, 100)
    const settled = pending.then(
      () => undefined,
      (error: unknown) => error
    )
    socket.emit('connect')
    await vi.advanceTimersByTimeAsync(100)
    const error = await settled
    expect(write).toHaveBeenCalledTimes(1)
    expect(error).toMatchObject({ code: 'runtime_timeout' })
    expect(error).not.toHaveProperty('data.requestSent')
  })

  it('rejects close with an incomplete frame and does not parse later data', async () => {
    const pending = sendRequest(metadata, 'terminal.read', {}, 30000)
    socket.emit('data', '{"id":')
    socket.emit('close')
    socket.emit('data', reply({ data: 'ignored' }))
    await expect(pending).rejects.toMatchObject({ code: 'runtime_unavailable' })
  })
})
