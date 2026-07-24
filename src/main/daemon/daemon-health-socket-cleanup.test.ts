import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { netConnectMock } = vi.hoisted(() => ({
  netConnectMock: vi.fn()
}))

vi.mock('net', () => ({ connect: netConnectMock }))

import { checkDaemonHealth, healthCheckDaemon, killStaleDaemon } from './daemon-health'
import { DAEMON_HANDSHAKE_MAX_LINE_BYTES } from './ndjson'

class FakeSocket extends EventEmitter {
  destroy = vi.fn()
  write = vi.fn()
}

describe('daemon health socket listener cleanup', () => {
  let dir: string
  let socketPath: string
  let tokenPath: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'daemon-health-socket-cleanup-'))
    socketPath = join(dir, 'daemon.sock')
    tokenPath = join(dir, 'daemon.token')
    writeFileSync(socketPath, '')
    writeFileSync(tokenPath, 'token')
    netConnectMock.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
    rmSync(dir, { recursive: true, force: true })
  })

  it('removes health-check socket listeners after a daemon response', async () => {
    const socket = new FakeSocket()
    netConnectMock.mockReturnValueOnce(socket)

    const result = healthCheckDaemon(socketPath, tokenPath)
    socket.emit('connect')
    socket.emit(
      'data',
      Buffer.from(
        '{"type":"hello","ok":true}\n{"id":"health-1","ok":true}\n{"id":"health-2","ok":true}\n'
      )
    )

    await expect(result).resolves.toBe(true)
    expect(socket.listenerCount('connect')).toBe(0)
    expect(socket.listenerCount('error')).toBe(0)
    expect(socket.listenerCount('data')).toBe(0)
    expect(socket.destroy).toHaveBeenCalledTimes(1)
  })

  it('removes health-check socket listeners after a timeout', async () => {
    vi.useFakeTimers()
    const socket = new FakeSocket()
    netConnectMock.mockReturnValueOnce(socket)

    const result = healthCheckDaemon(socketPath, tokenPath)
    await vi.advanceTimersByTimeAsync(3_000)

    await expect(result).resolves.toBe(false)
    expect(socket.listenerCount('connect')).toBe(0)
    expect(socket.listenerCount('error')).toBe(0)
    expect(socket.listenerCount('data')).toBe(0)
    expect(socket.destroy).toHaveBeenCalledTimes(1)
  })

  it('rejects and releases a newline-free oversized health response', async () => {
    const socket = new FakeSocket()
    netConnectMock.mockReturnValueOnce(socket)

    const result = checkDaemonHealth(socketPath, tokenPath)
    socket.emit('connect')
    socket.emit('data', Buffer.alloc(DAEMON_HANDSHAKE_MAX_LINE_BYTES + 1, 0x78))

    await expect(result).resolves.toBe('rejected')
    expect(socket.listenerCount('connect')).toBe(0)
    expect(socket.listenerCount('error')).toBe(0)
    expect(socket.listenerCount('data')).toBe(0)
    expect(socket.destroy).toHaveBeenCalledOnce()
  })

  it('removes stale-socket probe listeners after a timeout', async () => {
    vi.useFakeTimers()
    const socket = new FakeSocket()
    netConnectMock.mockReturnValueOnce(socket)

    const result = killStaleDaemon(dir, socketPath, tokenPath)
    await vi.advanceTimersByTimeAsync(500)

    await expect(result).resolves.toBe(false)
    expect(socket.listenerCount('connect')).toBe(0)
    expect(socket.listenerCount('error')).toBe(0)
    expect(socket.destroy).toHaveBeenCalledTimes(1)
  })
})
