import { EventEmitter } from 'events'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { netConnectMock } = vi.hoisted(() => ({
  netConnectMock: vi.fn()
}))

vi.mock('net', () => ({ connect: netConnectMock }))

import { healthCheckDaemon, killStaleDaemon } from './daemon-health'

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
