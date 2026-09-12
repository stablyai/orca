import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeMetadata } from '../../shared/runtime-bootstrap'

const { createConnection } = vi.hoisted(() => ({ createConnection: vi.fn() }))
vi.mock('node:net', () => ({ createConnection }))

import { sendOrcadSidecarRequest } from './orcad-sidecar-runtime-client'

function startRequest(timeout = 1000) {
  const socket = Object.assign(new EventEmitter(), {
    setEncoding: vi.fn(),
    write: vi.fn(),
    end: vi.fn(),
    destroy: vi.fn()
  })
  createConnection.mockReturnValue(socket)
  const metadata: RuntimeMetadata = {
    runtimeId: 'test',
    pid: 1,
    startedAt: 0,
    authToken: null,
    transports: [{ kind: 'named-pipe', endpoint: 'test-pipe' }]
  }
  const result = sendOrcadSidecarRequest(metadata, 'browser.screenshot', {}, timeout)
  socket.emit('connect')
  const request = JSON.parse(socket.write.mock.calls[0][0]) as { id: string }
  return { socket, result, id: request.id }
}

afterEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
})

describe('sidecar response framing', () => {
  it('does not rescan the accumulated response for each partial chunk', async () => {
    const { socket, result, id } = startRequest()
    const wire = `${JSON.stringify({ id, ok: true, result: 'x'.repeat(1024 * 1024) })}\n`
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
      for (let offset = 0; offset < wire.length; offset += 256) {
        socket.emit('data', wire.slice(offset, offset + 256))
      }
    } finally {
      search.mockRestore()
    }
    await expect(result).resolves.toHaveLength(1024 * 1024)
    expect(searchedCharacters).toBe(wire.length)
  })

  it('assembles a large response after fragmented keepalive and empty lines', async () => {
    const { socket, result, id } = startRequest()
    const expected = { image: 'A'.repeat(1024 * 1024), text: '😀é' }
    const wire = `\n${JSON.stringify({ _keepalive: true })}\n${JSON.stringify({ id, ok: true, result: expected })}\r\n`
    for (let offset = 0; offset < wire.length; offset += 8192) {
      socket.emit('data', wire.slice(offset, offset + 8192))
    }
    await expect(result).resolves.toEqual(expected)
    expect(socket.end).toHaveBeenCalledOnce()
  })

  it('refreshes the deadline for completed keepalive frames', async () => {
    vi.useFakeTimers()
    const { socket, result, id } = startRequest()
    await vi.advanceTimersByTimeAsync(600)
    socket.emit('data', '{"_keepalive":')
    socket.emit('data', 'true}\n')
    await vi.advanceTimersByTimeAsync(600)
    expect(socket.destroy).not.toHaveBeenCalled()
    socket.emit('data', `${JSON.stringify({ id, ok: true, result: 'done' })}\n`)
    await expect(result).resolves.toBe('done')
  })

  it('rejects oversized unterminated data before waiting for a newline', async () => {
    const { socket, result } = startRequest()
    const rejected = expect(result).rejects.toThrow('response is too large')
    const chunk = 'a'.repeat(1024 * 1024)
    for (let index = 0; index < 64; index += 1) {
      socket.emit('data', chunk)
    }
    expect(socket.destroy).not.toHaveBeenCalled()
    socket.emit('data', 'a')
    await rejected
    expect(socket.destroy).toHaveBeenCalledOnce()
  })

  it('rejects a fragmented response carrying another request id', async () => {
    const { socket, result } = startRequest()
    const rejected = expect(result).rejects.toThrow('invalid response')
    socket.emit('data', '{"id":"other",')
    socket.emit('data', '"ok":true,"result":null}\n')
    await rejected
  })
})
