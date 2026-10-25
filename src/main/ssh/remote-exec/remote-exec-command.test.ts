import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import type { ClientChannel } from 'ssh2'
import { execCommand } from './remote-exec-command'

type MockChannel = ClientChannel & {
  stdin: EventEmitter & { write: ReturnType<typeof vi.fn> }
}

function createMockChannel(): MockChannel {
  return Object.assign(new EventEmitter(), {
    stderr: Object.assign(new EventEmitter(), { resume: vi.fn() }),
    stdin: Object.assign(new EventEmitter(), { write: vi.fn(() => true) }),
    close: vi.fn(),
    resume: vi.fn()
  }) as unknown as MockChannel
}

// Require rejection and narrow its Error before checking diagnostics.
async function execCommandRejection(promise: Promise<string>): Promise<Error> {
  return promise.then(
    () => {
      throw new Error('expected execCommand to reject')
    },
    (err: Error) => err
  )
}

describe('execCommand', () => {
  const installMarkerToken = 'a'.repeat(32)
  const installMarkerPath = `/home/u/.install-lock/.sftp-namespace-${installMarkerToken}`

  it('waits for channel close before rejecting a timed-out remote command', async () => {
    vi.useFakeTimers()
    try {
      const channel = createMockChannel()
      const conn = { exec: vi.fn().mockResolvedValue(channel) }
      const commandPromise = execCommand(conn as never, 'npm rebuild', { timeoutMs: 1_000 })

      await vi.advanceTimersByTimeAsync(1_000)
      expect(channel.close).toHaveBeenCalledTimes(1)
      expect(
        await Promise.race([
          commandPromise.then(
            () => 'settled',
            () => 'settled'
          ),
          Promise.resolve('pending')
        ])
      ).toBe('pending')

      channel.emit('close', 0)
      await expect(commandPromise).rejects.toThrow('timed out after 1s')
    } finally {
      vi.useRealTimers()
    }
  })

  it('rejects on command channel errors instead of emitting uncaught errors', async () => {
    const channel = createMockChannel()
    const conn = {
      exec: vi.fn().mockResolvedValue(channel)
    }
    const commandPromise = execCommand(conn as never, 'uname -sm')

    await Promise.resolve()
    expect(() => channel.emit('error', new Error('remote host rebooted'))).not.toThrow()
    expect(channel.close).toHaveBeenCalledOnce()
    channel.emit('close', 1)
    await expect(commandPromise).rejects.toThrow('remote host rebooted')
    expect(channel.listenerCount('error')).toBe(0)
    expect(channel.listenerCount('data')).toBe(0)
    expect(channel.listenerCount('close')).toBe(0)
    expect(channel.stderr.listenerCount('error')).toBe(0)
    expect(channel.stderr.listenerCount('data')).toBe(0)
  })

  it('includes stdout in nonzero-exit errors when stderr is empty', async () => {
    const channel = createMockChannel()
    const conn = {
      exec: vi.fn().mockResolvedValue(channel)
    }
    const commandPromise = execCommand(conn as never, 'npm install node-pty 2>&1')

    await Promise.resolve()
    channel.emit('data', Buffer.from('gyp ERR! stack Error: not found: make\n'))
    channel.emit('close', 1)

    await expect(commandPromise).rejects.toThrow('gyp ERR! stack Error: not found: make')
    expect(channel.listenerCount('error')).toBe(0)
    expect(channel.listenerCount('data')).toBe(0)
    expect(channel.listenerCount('close')).toBe(0)
    expect(channel.stderr.listenerCount('error')).toBe(0)
    expect(channel.stderr.listenerCount('data')).toBe(0)
  })

  it('redacts install-owner marker tokens from command failures', async () => {
    const channel = createMockChannel()
    const conn = {
      exec: vi.fn().mockResolvedValue(channel)
    }
    const commandPromise = execCommand(conn as never, `touch '${installMarkerPath}'`)

    await Promise.resolve()
    channel.emit('data', Buffer.from(`touch failed for ${installMarkerPath}\n`))
    channel.emit('close', 1)

    const error = await execCommandRejection(commandPromise)
    expect(error.message).toContain('.sftp-namespace-[redacted]')
    expect(error.message).not.toContain(installMarkerToken)
  })

  it('redacts install-owner marker tokens from timeout errors', async () => {
    vi.useFakeTimers()
    try {
      const channel = createMockChannel()
      const conn = { exec: vi.fn().mockResolvedValue(channel) }
      const commandPromise = execCommand(conn as never, `touch '${installMarkerPath}'`, {
        timeoutMs: 1_000
      })

      await vi.advanceTimersByTimeAsync(1_000)
      channel.emit('close', 0)

      const error = await execCommandRejection(commandPromise)
      expect(error.message).toContain('.sftp-namespace-[redacted]')
      expect(error.message).not.toContain(installMarkerToken)
    } finally {
      vi.useRealTimers()
    }
  })

  it('surfaces stdout alongside stderr on nonzero exit instead of masking it', async () => {
    const channel = createMockChannel()
    const conn = {
      exec: vi.fn().mockResolvedValue(channel)
    }
    const commandPromise = execCommand(conn as never, 'npm install 2>&1')

    await Promise.resolve()
    // System SSH stderr carries local client noise; remote merged stdout must supply failure details.
    channel.stderr.emit('data', Buffer.from("Warning: Permanently added 'host' (ED25519)\n"))
    channel.emit('data', Buffer.from("npm error g++: unrecognized '-std=gnu++20'\n"))
    channel.emit('close', 1)

    const error = await execCommandRejection(commandPromise)
    expect(error.message).toContain('Permanently added')
    expect(error.message).toContain('gnu++20')
  })

  it('bounds command output while preserving the actionable tail', async () => {
    const channel = createMockChannel()
    const conn = { exec: vi.fn().mockResolvedValue(channel) }
    const commandPromise = execCommand(conn as never, 'npm rebuild')

    await Promise.resolve()
    channel.emit('data', Buffer.from(`old-prefix-${'x'.repeat(1024 * 1024)}`))
    channel.emit('data', Buffer.from('gyp ERR! tail diagnosis'))
    channel.emit('close', 1)

    const error = await execCommandRejection(commandPromise)
    expect(error.message).not.toContain('old-prefix')
    expect(error.message).toContain('gyp ERR! tail diagnosis')
    expect(error.message.length).toBeLessThan(1024 * 1024 + 200)
  })

  it('cleans command channel listeners when a command times out', async () => {
    vi.useFakeTimers()
    try {
      const channel = createMockChannel()
      const conn = {
        exec: vi.fn().mockResolvedValue(channel)
      }
      const commandPromise = execCommand(conn as never, 'sleep 60')

      await Promise.resolve()
      const rejection = expect(commandPromise).rejects.toThrow('timed out')
      await vi.advanceTimersByTimeAsync(30_000)
      expect(channel.close).toHaveBeenCalledOnce()
      await vi.advanceTimersByTimeAsync(5_000)

      await rejection
      expect(channel.close).toHaveBeenCalledOnce()
      expect(channel.resume).toHaveBeenCalledOnce()
      expect(channel.stderr.resume).toHaveBeenCalledOnce()
      expect(() => channel.emit('error', new Error('late channel error'))).not.toThrow()
      expect(() => channel.stderr.emit('error', new Error('late stderr error'))).not.toThrow()
      channel.emit('data', Buffer.from('late stdout'))
      channel.stderr.emit('data', Buffer.from('late stderr'))
      expect(channel.listenerCount('error')).toBe(1)
      expect(channel.listenerCount('data')).toBe(0)
      expect(channel.listenerCount('close')).toBe(1)
      expect(channel.stderr.listenerCount('error')).toBe(1)
      expect(channel.stderr.listenerCount('data')).toBe(0)
      channel.emit('close', 0)
      expect(channel.listenerCount('error')).toBe(0)
      expect(channel.listenerCount('close')).toBe(0)
      expect(channel.stderr.listenerCount('error')).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('closes and rejects with AbortError when a command is aborted', async () => {
    const channel = createMockChannel()
    const controller = new AbortController()
    const conn = {
      exec: vi.fn().mockResolvedValue(channel)
    }
    const commandPromise = execCommand(conn as never, 'sleep 60', {
      signal: controller.signal
    })

    await Promise.resolve()
    controller.abort()

    // Abort must await CHANNEL_CLOSE or MaxSessions fallback races a still-held session slot.
    expect(channel.close).toHaveBeenCalledOnce()
    const settledEarly = await Promise.race([
      commandPromise.then(
        () => 'settled',
        () => 'settled'
      ),
      Promise.resolve('pending')
    ])
    expect(settledEarly).toBe('pending')
    channel.emit('close', 0)

    await expect(commandPromise).rejects.toMatchObject({ name: 'AbortError' })
    expect(channel.listenerCount('error')).toBe(0)
    expect(channel.listenerCount('data')).toBe(0)
    expect(channel.listenerCount('close')).toBe(0)
    expect(channel.stderr.listenerCount('error')).toBe(0)
    expect(channel.stderr.listenerCount('data')).toBe(0)
  })

  it('keeps system-SSH command termination unconfirmed after the local child closes', async () => {
    const channel = createMockChannel()
    const controller = new AbortController()
    const conn = {
      exec: vi.fn().mockResolvedValue(channel),
      usesSystemSshTransport: vi.fn().mockReturnValueOnce(true).mockReturnValue(false)
    }
    const commandPromise = execCommand(conn as never, 'npm install', {
      signal: controller.signal
    })

    await Promise.resolve()
    controller.abort()
    channel.emit('close', 0)

    await expect(commandPromise).rejects.toMatchObject({
      name: 'AbortError',
      sshChannelCloseConfirmed: false
    })
  })

  it('tags an externally closed system-SSH command as unconfirmed', async () => {
    const channel = createMockChannel() as ClientChannel & { _closeRequested?: boolean }
    channel.close = vi.fn(() => {
      channel._closeRequested = true
    })
    const conn = {
      exec: vi.fn().mockResolvedValue(channel),
      usesSystemSshTransport: vi.fn().mockReturnValue(true)
    }
    const commandPromise = execCommand(conn as never, 'npm install')

    await Promise.resolve()
    channel.close()
    channel.emit('close', 1)

    await expect(commandPromise).rejects.toMatchObject({
      name: 'AbortError',
      sshChannelCloseConfirmed: false
    })
  })

  it('handles aborts that happen while the SSH exec channel is still opening', async () => {
    const channel = createMockChannel()
    const controller = new AbortController()
    let resolveExec: (channel: ClientChannel) => void = () => {}
    const conn = {
      exec: vi.fn().mockReturnValue(
        new Promise<ClientChannel>((resolve) => {
          resolveExec = resolve
        })
      )
    }

    const commandPromise = execCommand(conn as never, 'sleep 60', {
      signal: controller.signal
    })
    controller.abort()
    resolveExec(channel)

    await Promise.resolve()
    await Promise.resolve()
    expect(channel.close).toHaveBeenCalledOnce()
    // Nonzero exit from the killed command must still surface as AbortError.
    channel.emit('close', 1)

    await expect(commandPromise).rejects.toMatchObject({ name: 'AbortError' })
    expect(channel.listenerCount('error')).toBe(0)
    expect(channel.listenerCount('data')).toBe(0)
    expect(channel.listenerCount('close')).toBe(0)
    expect(channel.stderr.listenerCount('error')).toBe(0)
    expect(channel.stderr.listenerCount('data')).toBe(0)
  })

  it('hands a zero-exit command stderr to onStderr instead of dropping it', async () => {
    // Zero-exit probes wrapped in || echo MISSING still need their stderr diagnostics.
    const channel = createMockChannel()
    const conn = { exec: vi.fn().mockResolvedValue(channel) }
    const captured: string[] = []
    const commandPromise = execCommand(conn as never, "(node -e 'x' || echo MISSING)", {
      onStderr: (stderr) => captured.push(stderr)
    })

    await Promise.resolve()
    channel.stderr.emit('data', Buffer.from('node: --bogus is not allowed in NODE_OPTIONS\n'))
    channel.emit('data', Buffer.from('MISSING\n'))
    channel.emit('close', 0)

    await expect(commandPromise).resolves.toBe('MISSING\n')
    expect(captured).toEqual(['node: --bogus is not allowed in NODE_OPTIONS\n'])
    // onStderr must not leak into the SSH exec options.
    expect(conn.exec).toHaveBeenCalledWith(
      expect.stringContaining("\n(node -e 'x' || echo MISSING)\n"),
      { compressCommand: true }
    )
  })

  it('uses custom command timeouts without forwarding them to SSH exec', async () => {
    vi.useFakeTimers()
    try {
      const channel = createMockChannel()
      const conn = {
        exec: vi.fn().mockResolvedValue(channel)
      }
      const commandPromise = execCommand(conn as never, 'npm install', {
        wrapCommand: false,
        timeoutMs: 240_000
      })

      await Promise.resolve()
      expect(conn.exec).toHaveBeenCalledWith('npm install', {
        wrapCommand: false,
        compressCommand: true
      })
      const rejection = expect(commandPromise).rejects.toThrow('timed out after 240s')
      await vi.advanceTimersByTimeAsync(240_000)
      expect(channel.close).toHaveBeenCalledOnce()
      await vi.advanceTimersByTimeAsync(5_000)

      await rejection
      expect(channel.close).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })
})
