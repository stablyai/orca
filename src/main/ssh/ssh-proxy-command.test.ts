import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { spawnMock } = vi.hoisted(() => ({
  spawnMock: vi.fn()
}))

vi.mock('child_process', () => ({
  spawn: spawnMock
}))

import { spawnProxyCommand } from './ssh-proxy-command'

type MockProxyProcess = EventEmitter & {
  stdin: EventEmitter & {
    write: ReturnType<typeof vi.fn>
    end: ReturnType<typeof vi.fn>
    destroy: ReturnType<typeof vi.fn>
  }
  stdout: EventEmitter & {
    pause: ReturnType<typeof vi.fn>
    resume: ReturnType<typeof vi.fn>
    destroy: ReturnType<typeof vi.fn>
  }
  stderr: EventEmitter & { destroy: ReturnType<typeof vi.fn> }
  exitCode: number | null
  killed: boolean
  kill: ReturnType<typeof vi.fn>
}

function createMockProxyProcess(): MockProxyProcess {
  const proc: MockProxyProcess = Object.assign(new EventEmitter(), {
    stdin: Object.assign(new EventEmitter(), {
      write: vi.fn((_chunk, cb?: (error?: Error | null) => void) => cb?.()),
      end: vi.fn((cb?: () => void) => cb?.()),
      destroy: vi.fn()
    }),
    stdout: Object.assign(new EventEmitter(), {
      pause: vi.fn(),
      resume: vi.fn(),
      destroy: vi.fn()
    }),
    stderr: Object.assign(new EventEmitter(), { destroy: vi.fn() }),
    exitCode: null,
    killed: false,
    kill: vi.fn()
  })
  proc.kill.mockImplementation(() => {
    proc.killed = true
    return true
  })
  return proc
}

// ── spawnProxyCommand ───────────────────────────────────────────────

describe('spawnProxyCommand', () => {
  beforeEach(() => {
    spawnMock.mockReset()
  })

  it('keeps error guards until the destroyed proxy process actually closes', () => {
    const proc = createMockProxyProcess()
    spawnMock.mockReturnValue(proc)

    const { sock } = spawnProxyCommand(
      { kind: 'jump-host', jumpHost: 'bastion.example.com' },
      'target.example.com',
      22,
      'deploy'
    )

    expect(proc.stdout.listenerCount('data')).toBe(1)
    expect(proc.stdout.listenerCount('end')).toBe(1)
    expect(proc.stderr.listenerCount('data')).toBe(1)
    expect(proc.stdin.listenerCount('error')).toBe(1)
    expect(proc.stdout.listenerCount('error')).toBe(1)
    expect(proc.stderr.listenerCount('error')).toBe(1)
    expect(proc.listenerCount('error')).toBe(1)

    sock.destroy()

    expect(proc.stdout.listenerCount('data')).toBe(0)
    expect(proc.stdout.listenerCount('end')).toBe(0)
    expect(proc.stderr.listenerCount('data')).toBe(0)
    for (const emitter of [proc, proc.stdin, proc.stdout, proc.stderr]) {
      expect(emitter.listenerCount('error')).toBe(1)
      expect(() => emitter.emit('error', new Error('late teardown error'))).not.toThrow()
    }
    expect(proc.listenerCount('close')).toBe(1)

    proc.emit('close', null, 'SIGTERM')

    expect(proc.stdin.listenerCount('error')).toBe(0)
    expect(proc.stdout.listenerCount('error')).toBe(0)
    expect(proc.stderr.listenerCount('error')).toBe(0)
    expect(proc.listenerCount('error')).toBe(0)
    expect(proc.listenerCount('close')).toBe(0)
  })

  it('destroys every owned pipe and signals the child only once', () => {
    const proc = createMockProxyProcess()
    spawnMock.mockReturnValue(proc)
    const { sock } = spawnProxyCommand(
      { kind: 'jump-host', jumpHost: 'bastion.example.com' },
      'target.example.com',
      22,
      'deploy'
    )

    sock.destroy()
    sock.destroy()

    expect(proc.stdin.destroy).toHaveBeenCalledTimes(1)
    expect(proc.stdout.destroy).toHaveBeenCalledTimes(1)
    expect(proc.stderr.destroy).toHaveBeenCalledTimes(1)
    expect(proc.kill).toHaveBeenCalledExactlyOnceWith('SIGTERM')
  })

  it.each(['process', 'stdin', 'stdout', 'stderr'] as const)(
    'propagates a live %s error and absorbs later teardown errors',
    async (source) => {
      const proc = createMockProxyProcess()
      spawnMock.mockReturnValue(proc)
      const { sock } = spawnProxyCommand(
        { kind: 'jump-host', jumpHost: 'bastion.example.com' },
        'target.example.com',
        22,
        'deploy'
      )
      const errors: Error[] = []
      sock.on('error', (error) => errors.push(error))
      const closed = new Promise<void>((resolve) => sock.once('close', resolve))
      const error = new Error(`${source} failure`)
      const emitter = source === 'process' ? proc : proc[source]

      emitter.emit('error', error)
      await closed

      expect(errors).toEqual([error])
      expect(proc.kill).toHaveBeenCalledExactlyOnceWith('SIGTERM')
      expect(() => emitter.emit('error', new Error('late error'))).not.toThrow()
      proc.emit('close', null, 'SIGTERM')
      expect(emitter.listenerCount('error')).toBe(0)
    }
  )

  it('releases listeners on natural child close without discarding unread output', () => {
    const proc = createMockProxyProcess()
    spawnMock.mockReturnValue(proc)
    const { sock } = spawnProxyCommand(
      { kind: 'jump-host', jumpHost: 'bastion.example.com' },
      'target.example.com',
      22,
      'deploy'
    )

    proc.stdout.emit('data', Buffer.from('final output'))
    proc.stdout.emit('end')
    proc.exitCode = 0
    proc.emit('close', 0, null)

    expect(proc.stdout.listenerCount('data')).toBe(0)
    expect(proc.listenerCount('error')).toBe(0)
    expect(sock.read()).toEqual(Buffer.from('final output'))
    sock.destroy()
    expect(sock.destroyed).toBe(true)
    expect(proc.kill).not.toHaveBeenCalled()
    expect(proc.stdout.listenerCount('data')).toBe(0)
    expect(proc.listenerCount('close')).toBe(0)
    expect(proc.listenerCount('error')).toBe(0)
  })

  it('does not signal a child that teardown already killed', () => {
    const proc = createMockProxyProcess()
    proc.killed = true
    spawnMock.mockReturnValue(proc)
    const { sock } = spawnProxyCommand(
      { kind: 'jump-host', jumpHost: 'bastion.example.com' },
      'target.example.com',
      22,
      'deploy'
    )

    sock.destroy()
    proc.emit('close', null, 'SIGTERM')

    expect(proc.kill).not.toHaveBeenCalled()
    expect(proc.stdin.destroy).toHaveBeenCalledOnce()
  })

  it('releases the pipes even if signaling races with child exit', () => {
    const proc = createMockProxyProcess()
    proc.kill.mockImplementation(() => {
      throw new Error('already exited')
    })
    spawnMock.mockReturnValue(proc)
    const { sock } = spawnProxyCommand(
      { kind: 'jump-host', jumpHost: 'bastion.example.com' },
      'target.example.com',
      22,
      'deploy'
    )

    expect(() => sock.destroy()).not.toThrow()
    expect(proc.stdin.destroy).toHaveBeenCalledOnce()
    expect(proc.stdout.destroy).toHaveBeenCalledOnce()
    expect(proc.stderr.destroy).toHaveBeenCalledOnce()
    proc.emit('close', 0, null)
  })

  it('drains proxy stderr so the pipe cannot fill and block the child', () => {
    const proc = createMockProxyProcess()
    spawnMock.mockReturnValue(proc)
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

    spawnProxyCommand(
      { kind: 'jump-host', jumpHost: 'bastion.example.com' },
      'target.example.com',
      22,
      'deploy'
    )
    proc.stderr.emit('data', Buffer.from('bastion: permission denied\n'))

    expect(consoleError).toHaveBeenCalledWith('[ssh-proxy-command] bastion: permission denied')
    consoleError.mockRestore()
  })

  it('expands a comma-separated ProxyJump chain into -J plus a final hop', () => {
    spawnMock.mockReturnValue(createMockProxyProcess())

    spawnProxyCommand(
      { kind: 'jump-host', jumpHost: 'first.example.com, second.example.com,third.example.com' },
      'target.example.com',
      2222,
      'deploy'
    )

    expect(spawnMock).toHaveBeenCalledWith(
      'ssh',
      [
        '-W',
        'target.example.com:2222',
        '-J',
        'first.example.com,second.example.com',
        '--',
        'third.example.com'
      ],
      expect.anything()
    )
  })

  it('tunnels a single ProxyJump hop without a -J chain', () => {
    spawnMock.mockReturnValue(createMockProxyProcess())

    spawnProxyCommand(
      { kind: 'jump-host', jumpHost: 'bastion.example.com' },
      'target.example.com',
      22,
      'deploy'
    )

    expect(spawnMock).toHaveBeenCalledWith(
      'ssh',
      ['-W', 'target.example.com:22', '--', 'bastion.example.com'],
      expect.anything()
    )
  })

  it('pauses the proxy stdout when the transport stream applies backpressure', () => {
    const proc = createMockProxyProcess()
    spawnMock.mockReturnValue(proc)

    const { sock } = spawnProxyCommand(
      { kind: 'jump-host', jumpHost: 'bastion.example.com' },
      'target.example.com',
      22,
      'deploy'
    )
    // Nothing reads the Duplex, so pushing past the high-water mark backs up.
    for (let i = 0; i < 64; i += 1) {
      proc.stdout.emit('data', Buffer.alloc(4096))
    }

    expect(proc.stdout.pause).toHaveBeenCalled()

    while (sock.read() !== null) {
      // Drain below the high-water mark so the Duplex asks for more.
    }

    expect(proc.stdout.resume).toHaveBeenCalled()
  })

  describe('on Windows', () => {
    const realPlatform = process.platform

    const setPlatform = (platform: string): void => {
      Object.defineProperty(process, 'platform', { value: platform, configurable: true })
    }

    afterEach(() => {
      setPlatform(realPlatform)
    })

    it('passes the cmd.exe command line verbatim so inner quotes survive', () => {
      setPlatform('win32')
      spawnMock.mockReturnValue(createMockProxyProcess())

      spawnProxyCommand(
        { kind: 'proxy-command', command: 'cloudflared access ssh --hostname %h --port %p' },
        'target.example.com',
        22,
        'deploy'
      )

      expect(spawnMock).toHaveBeenCalledWith(
        process.env.ComSpec || 'cmd.exe',
        ['/d', '/s', '/c', '"cloudflared access ssh --hostname "target.example.com" --port "22""'],
        expect.objectContaining({ windowsVerbatimArguments: true })
      )
    })

    it('refuses values that cmd.exe cannot quote safely', () => {
      setPlatform('win32')
      spawnMock.mockReturnValue(createMockProxyProcess())

      expect(() =>
        spawnProxyCommand(
          { kind: 'proxy-command', command: 'cloudflared access ssh --hostname %h' },
          'host&echo injected',
          22,
          'deploy'
        )
      ).toThrow(/cannot be safely expanded on Windows/)
      expect(spawnMock).not.toHaveBeenCalled()
    })
  })
})
