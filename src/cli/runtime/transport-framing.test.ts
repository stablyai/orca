import '../../shared/remote-runtime/host-store/environment-store-worker.test-support'
import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeMetadata } from '../../shared/runtime-bootstrap'
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
  it('reads a response split across chunks without losing its payload', async () => {
    const encoded = reply({ data: '界😀done' })
    const pending = sendRequest(metadata, 'terminal.read', {}, 30000)
    socket.emit('data', encoded.slice(0, 7))
    socket.emit('data', encoded.slice(7))
    await expect(pending).resolves.toMatchObject({ result: { data: '界😀done' } })
  })

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

  it('rejects close with an incomplete frame and does not parse later data', async () => {
    const pending = sendRequest(metadata, 'terminal.read', {}, 30000)
    socket.emit('data', '{"id":')
    socket.emit('close')
    socket.emit('data', reply({ data: 'ignored' }))
    await expect(pending).rejects.toMatchObject({ code: 'runtime_unavailable' })
  })

  it('rejects a timed out incomplete frame and ignores a late reply', async () => {
    vi.useFakeTimers()
    const pending = sendRequest(metadata, 'terminal.read', {}, 100)
    const rejected = expect(pending).rejects.toMatchObject({ code: 'runtime_timeout' })
    socket.emit('data', '{"id":')
    await vi.advanceTimersByTimeAsync(100)
    socket.emit('data', reply({ data: 'ignored' }))
    await rejected
  })
})
