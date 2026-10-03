import { EventEmitter } from 'node:events'
import { StringDecoder } from 'node:string_decoder'
import { rmSync } from 'node:fs'
import { createConnection, type Socket } from 'node:net'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { UnixSocketTransport } from './unix-socket-transport'

class FakeSocket extends EventEmitter {
  destroyed = false
  writable = true
  readonly writes: string[] = []
  idleTimeoutMs = 0
  private idleTimer: ReturnType<typeof setTimeout> | null = null

  setEncoding(): void {}
  setNoDelay(): void {}
  end(): void {}

  // Mirrors net.Socket: 0 disables, activity restarts the countdown.
  setTimeout(ms: number, callback?: () => void): void {
    this.idleTimeoutMs = ms
    if (callback) {
      this.once('timeout', callback)
    }
    this.restartIdleTimer()
  }

  private restartIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer)
      this.idleTimer = null
    }
    if (this.idleTimeoutMs > 0 && !this.destroyed) {
      this.idleTimer = setTimeout(() => this.emit('timeout'), this.idleTimeoutMs)
    }
  }

  receive(data: string): void {
    this.restartIdleTimer()
    this.emit('data', data)
  }

  write(data: string): boolean {
    this.writes.push(data)
    this.restartIdleTimer()
    return true
  }

  destroy(): this {
    if (!this.destroyed) {
      this.destroyed = true
      if (this.idleTimer) {
        clearTimeout(this.idleTimer)
        this.idleTimer = null
      }
      this.writable = false
      this.emit('close')
    }
    return this
  }
}

type UnixSocketTransportInternals = {
  handleConnection(socket: Socket): void
}

describe('UnixSocketTransport', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  function createReceiver(
    handler: Parameters<UnixSocketTransport['onMessage']>[0] = (_message, reply) => reply('ok')
  ) {
    const transport = new UnixSocketTransport({ endpoint: 'test-pipe', kind: 'named-pipe' })
    const socket = new FakeSocket()
    const received: string[] = []
    transport.onMessage((message, reply, context) => {
      received.push(message)
      handler(message, reply, context)
    })
    ;(transport as unknown as UnixSocketTransportInternals).handleConnection(
      socket as unknown as Socket
    )
    return { socket, received }
  }

  it.each([false, true])('preserves the UTF-8 byte boundary with oversized=%s', (oversized) => {
    const { socket, received } = createReceiver()
    const message = `${'é'.repeat(524287)}a${oversized ? 'x' : ''}`
    const wire = Buffer.from(`${message}\n`)
    const decoder = new StringDecoder('utf8')
    for (let offset = 0; offset < wire.length; offset += 4095) {
      socket.emit('data', decoder.write(wire.subarray(offset, offset + 4095)))
    }
    expect(received).toEqual([oversized ? '' : message])
  })

  it('retains only the byte count of the partial tail between messages', () => {
    const { socket, received } = createReceiver()
    const large = 'a'.repeat(700000)
    socket.emit('data', `${large}\npart`)
    socket.emit('data', `ial\r\n\n${large}\n`)
    expect(received).toEqual([large, 'partial', large])
  })

  it('checks the combined incoming buffer before dispatching any complete messages', () => {
    const { socket, received } = createReceiver()
    socket.emit('data', `${'a'.repeat(700000)}\n${'b'.repeat(700000)}\n`)
    expect(received).toEqual([''])
    socket.emit('data', 'later\n')
    expect(received).toEqual([''])
  })

  it('clears request keepalive timers when the socket closes before a reply', () => {
    const transport = new UnixSocketTransport({
      endpoint: '/tmp/orca-runtime-rpc-test.sock',
      kind: 'unix',
      keepaliveIntervalMs: 100
    })
    const socket = new FakeSocket()
    let aborted = false

    transport.onMessage((_msg, _reply, context) => {
      context?.signal?.addEventListener(
        'abort',
        () => {
          aborted = true
        },
        { once: true }
      )
      context?.startKeepalive()
    })

    ;(transport as unknown as UnixSocketTransportInternals).handleConnection(
      socket as unknown as Socket
    )
    socket.emit('data', '{"id":"pending","method":"wait"}\n')

    vi.advanceTimersByTime(100)
    expect(socket.writes).toHaveLength(1)

    socket.destroy()
    expect(aborted).toBe(true)

    vi.advanceTimersByTime(500)
    expect(socket.writes).toHaveLength(1)
  })

  describe('idle timeout', () => {
    function createDeferredReceiver() {
      const replies: ((response: string) => void)[] = []
      let aborted = 0
      const { socket } = createReceiver((_message, reply, context) => {
        context?.signal?.addEventListener('abort', () => {
          aborted += 1
        })
        replies.push(reply)
      })
      return { socket, replies, aborted: () => aborted }
    }

    it('reaps a connection that never sends a request', () => {
      const { socket } = createDeferredReceiver()
      vi.advanceTimersByTime(29_999)
      expect(socket.destroyed).toBe(false)
      vi.advanceTimersByTime(1)
      expect(socket.destroyed).toBe(true)
    })

    it('delivers the reply of a request that runs past the idle timeout', () => {
      const { socket, replies } = createDeferredReceiver()
      socket.receive('{"id":"slow","method":"worktree.create"}\n')
      vi.advanceTimersByTime(35_000)
      expect(socket.destroyed).toBe(false)
      replies[0]('{"id":"slow","ok":true}')
      expect(socket.writes).toEqual(['{"id":"slow","ok":true}\n'])
    })

    it('re-arms the idle timeout once the last in-flight request replies', () => {
      const { socket, replies } = createDeferredReceiver()
      socket.receive('{"id":"a"}\n{"id":"b"}\n')
      vi.advanceTimersByTime(40_000)
      replies[0]('a')
      vi.advanceTimersByTime(40_000)
      expect(socket.destroyed).toBe(false)
      replies[1]('b')
      vi.advanceTimersByTime(29_999)
      expect(socket.destroyed).toBe(false)
      vi.advanceTimersByTime(1)
      expect(socket.destroyed).toBe(true)
    })

    it('aborts and releases an in-flight request when the client disconnects', () => {
      const { socket, replies, aborted } = createDeferredReceiver()
      socket.receive('{"id":"slow"}\n')
      vi.advanceTimersByTime(35_000)
      socket.destroy()
      expect(aborted()).toBe(1)
      replies[0]('late')
      expect(socket.writes).toEqual([])
      expect(vi.getTimerCount()).toBe(0)
    })
  })
})

// Resolves with the first reply line; rejects if the server closes first, as the CLI does.
function requestOverRealSocket(endpoint: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(endpoint)
    let buffer = ''
    socket.setEncoding('utf8')
    socket.once('error', reject)
    socket.on('connect', () => socket.write('{"id":"slow"}\n'))
    socket.on('data', (chunk: string) => {
      buffer += chunk
      if (buffer.includes('\n')) {
        socket.end()
        resolve(buffer.slice(0, buffer.indexOf('\n')))
      }
    })
    socket.once('close', () => reject(new Error('closed before responding')))
  })
}

describe.skipIf(process.platform === 'win32')(
  'UnixSocketTransport idle timeout on a real socket',
  () => {
    const endpoint = `/tmp/orca-idle-${process.pid}.sock`
    let transport: UnixSocketTransport | null = null

    afterEach(async () => {
      await transport?.stop()
      transport = null
      rmSync(endpoint, { force: true })
    })

    it('returns the real response when a request outlasts the idle timeout', async () => {
      transport = new UnixSocketTransport({ endpoint, kind: 'unix', idleTimeoutMs: 100 })
      transport.onMessage((_msg, reply) => {
        setTimeout(() => reply('{"id":"slow","ok":true}'), 400)
      })
      await transport.start()
      await expect(requestOverRealSocket(endpoint)).resolves.toBe('{"id":"slow","ok":true}')
    })

    it('still closes a connection that sends nothing', async () => {
      transport = new UnixSocketTransport({ endpoint, kind: 'unix', idleTimeoutMs: 100 })
      await transport.start()
      const closedAfterMs = await new Promise<number>((resolve, reject) => {
        const startedAt = Date.now()
        const socket = createConnection(endpoint)
        socket.once('error', reject)
        socket.once('close', () => resolve(Date.now() - startedAt))
      })
      expect(closedAfterMs).toBeLessThan(2_000)
    })
  }
)
