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
  stdin: EventEmitter & { write: ReturnType<typeof vi.fn> }
  stdout: EventEmitter & { pause: ReturnType<typeof vi.fn>; resume: ReturnType<typeof vi.fn> }
  stderr: EventEmitter
}

function createMockProxyProcess(): MockProxyProcess {
  const proc = new EventEmitter() as MockProxyProcess
  proc.stdin = Object.assign(new EventEmitter(), {
    write: vi.fn((_chunk, cb?: (error?: Error | null) => void) => cb?.())
  })
  proc.stdout = Object.assign(new EventEmitter(), { pause: vi.fn(), resume: vi.fn() })
  proc.stderr = new EventEmitter()
  return proc
}

// ── spawnProxyCommand ───────────────────────────────────────────────

describe('spawnProxyCommand', () => {
  beforeEach(() => {
    spawnMock.mockReset()
  })

  it('removes proxy process listeners when the socket is destroyed', () => {
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
    expect(proc.listenerCount('error')).toBe(1)

    sock.destroy()

    expect(proc.stdout.listenerCount('data')).toBe(0)
    expect(proc.stdout.listenerCount('end')).toBe(0)
    expect(proc.stderr.listenerCount('data')).toBe(0)
    expect(proc.stdin.listenerCount('error')).toBe(0)
    expect(proc.listenerCount('error')).toBe(0)
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
