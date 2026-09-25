import { EventEmitter } from 'node:events'
import { StringDecoder } from 'node:string_decoder'
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

describe('CLI runtime response framing', () => {
  it.each([1, 7, 256, 4096])(
    'reads a fragmented response with %i-character chunks',
    async (size) => {
      const result = { data: '界😀'.repeat(10000) }
      const encoded = reply(result)
      const pending = sendRequest(metadata, 'terminal.read', {}, 30000)
      for (let offset = 0; offset < encoded.length; offset += size) {
        socket.emit('data', encoded.slice(offset, offset + size))
      }
      await expect(pending).resolves.toMatchObject({ result })
      expect(socket.setEncoding).toHaveBeenCalledExactlyOnceWith('utf8')
      expect(socket.end).toHaveBeenCalledOnce()
    }
  )

  it('accepts Unicode split across socket bytes using the existing UTF-8 decoder', async () => {
    const pending = sendRequest(metadata, 'terminal.read', {}, 30000)
    const decoder = new StringDecoder('utf8')
    for (const byte of Buffer.from(reply({ data: '界😀é' }))) {
      socket.emit('data', decoder.write(Buffer.from([byte])))
    }
    socket.emit('data', decoder.end())
    await expect(pending).resolves.toMatchObject({ result: { data: '界😀é' } })
  })

  it('searches each fragment once without rescanning the accumulated reply', async () => {
    const encoded = reply({ data: 'x'.repeat(1024 * 1024) })
    const pending = sendRequest(metadata, 'terminal.read', {}, 30000)
    const originalIndexOf = String.prototype.indexOf
    let searchedCharacters = 0
    const search = vi
      .spyOn(String.prototype, 'indexOf')
      .mockImplementation(function (this: string, value, position) {
        if (value === '\n') {
          searchedCharacters += this.length - (position ?? 0)
        }
        return originalIndexOf.call(this, value, position)
      })
    try {
      for (let offset = 0; offset < encoded.length; offset += 256) {
        socket.emit('data', encoded.slice(offset, offset + 256))
      }
    } finally {
      search.mockRestore()
    }
    await expect(pending).resolves.toMatchObject({ ok: true })
    expect(searchedCharacters).toBe(encoded.length)
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
    expect(socket.end).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each([
    ['broken JSON\n', 'invalid_runtime_response'],
    ['{}\n', 'invalid_runtime_response'],
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
      expect(socket.end).toHaveBeenCalledOnce()
    }
  )

  it('preserves terminal failure envelopes', async () => {
    const pending = sendRequest(metadata, 'terminal.read', {}, 30000)
    socket.emit('data', '{"id":"request-1","ok":false,"error":{"code":"bad","message":"no"}}\n')
    await expect(pending).resolves.toMatchObject({
      ok: false,
      error: { code: 'bad', message: 'no' }
    })
  })

  it('rejects close with an incomplete frame and does not parse later data', async () => {
    const pending = sendRequest(metadata, 'terminal.read', {}, 30000)
    socket.emit('data', '{"id":')
    socket.emit('close')
    socket.emit('data', reply({ data: 'ignored' }))
    await expect(pending).rejects.toMatchObject({ code: 'runtime_unavailable' })
    expect(socket.end).toHaveBeenCalledOnce()
  })

  it('destroys a timed out socket holding an incomplete frame', async () => {
    vi.useFakeTimers()
    const pending = sendRequest(metadata, 'terminal.read', {}, 100)
    const rejected = expect(pending).rejects.toMatchObject({ code: 'runtime_timeout' })
    socket.emit('data', '{"id":')
    await vi.advanceTimersByTimeAsync(100)
    socket.emit('data', reply({ data: 'ignored' }))
    await rejected
    expect(socket.destroy).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })
})
