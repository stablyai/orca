import { describe, expect, it, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'
import {
  clientInstances,
  pendingExecCallback,
  pendingSftpCallback,
  resetSshConnectionMocks,
  ssh2Mock
} from './ssh-connection-test-harness'
import { createCallbacks, createTarget } from './ssh-connection-test-fixtures'
import { SshConnection } from './ssh-connection'

vi.mock('ssh2', async () => (await import('./ssh-connection-test-harness')).createSsh2Module())
vi.mock('./system-ssh-binary', async () =>
  (await import('./ssh-connection-test-harness')).createSystemSshBinaryModule()
)
vi.mock('./ssh-system-fallback', async () =>
  (await import('./ssh-connection-test-harness')).createSystemFallbackModule()
)
vi.mock('./ssh-control-socket', async () =>
  (await import('./ssh-connection-test-harness')).createControlSocketModule()
)
vi.mock('./ssh-config-parser', async () =>
  (await import('./ssh-connection-test-harness')).createSshConfigParserModule()
)

describe('SshConnection', () => {
  beforeEach(() => {
    resetSshConnectionMocks()
  })

  it('wraps exec commands as a single line that csh/tcsh login shells cannot break', async () => {
    const conn = new SshConnection(createTarget(), createCallbacks())
    await conn.connect()

    const original = "cd '/tmp' && ('/usr/bin/node' -e 'console.log(1)' || echo MISSING)"
    await conn.exec(original)

    const wrapped = clientInstances[0].lastExecCommand!
    // Why: sshd lets the login shell parse this first, so raw newlines let
    // csh/tcsh split the command before /bin/sh receives it (issue #8701).
    expect(wrapped).not.toContain('\n')
    expect(wrapped).toMatch(/^exec \/bin\/sh -c '.*printf %b .*' orca-command /)
    expect(wrapped).not.toContain('base64')
  })

  it('can execute native remote commands without the POSIX shell wrapper', async () => {
    const conn = new SshConnection(createTarget(), createCallbacks())
    await conn.connect()

    await conn.exec('powershell.exe -NoProfile -EncodedCommand AAAA', { wrapCommand: false })

    expect(clientInstances[0].lastExecCommand).toBe(
      'powershell.exe -NoProfile -EncodedCommand AAAA'
    )
  })

  it('times out when ssh2 never opens an exec channel', async () => {
    const conn = new SshConnection(createTarget(), createCallbacks())
    await conn.connect()
    ssh2Mock.execBehavior = 'pending'

    vi.useFakeTimers()
    try {
      const outcomePromise = conn.exec('printf ready').catch((error: Error) => error)

      await vi.advanceTimersByTimeAsync(30_000)
      const outcome = await Promise.race([outcomePromise, Promise.resolve('pending')])

      expect(outcome).toMatchObject({
        message: 'SSH exec channel timed out',
        sshChannelCloseConfirmed: false
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('closes a late exec callback after the channel-open timeout settles', async () => {
    const conn = new SshConnection(createTarget(), createCallbacks())
    await conn.connect()
    ssh2Mock.execBehavior = 'pending'
    const lateChannel = { close: vi.fn() }

    vi.useFakeTimers()
    try {
      const outcomePromise = conn
        .exec('printf ready')
        .then(() => 'opened')
        .catch((error: Error) => error.message)

      await vi.advanceTimersByTimeAsync(30_000)
      pendingExecCallback?.(undefined, lateChannel)

      await expect(outcomePromise).resolves.toBe('SSH exec channel timed out')
      expect(lateChannel.close).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('retries a session-limit-refused exec open and succeeds on a later attempt', async () => {
    const conn = new SshConnection(createTarget(), createCallbacks())
    await conn.connect()
    const channel = { close: vi.fn() }
    const execMock = vi
      .fn<(cmd: string, cb: (err: Error | undefined, ch: unknown) => void) => void>()
      .mockImplementationOnce((_cmd, cb) => {
        cb(
          Object.assign(new Error('(SSH) Channel open failure: open failed'), { reason: 2 }),
          undefined
        )
      })
      .mockImplementation((_cmd, cb) => cb(undefined, channel))
    clientInstances[0].exec = execMock as never

    await expect(conn.exec('printf ready')).resolves.toBe(channel)
    expect(execMock).toHaveBeenCalledTimes(2)
  })

  it('surfaces the session-limit error once open retries are exhausted', async () => {
    const conn = new SshConnection(createTarget(), createCallbacks())
    await conn.connect()
    const refusal = Object.assign(new Error('(SSH) Channel open failure: open failed'), {
      reason: 2
    })
    const execMock = vi
      .fn<(cmd: string, cb: (err: Error | undefined, ch: unknown) => void) => void>()
      .mockImplementation((_cmd, cb) => cb(refusal, undefined))
    clientInstances[0].exec = execMock as never

    await expect(conn.exec('printf ready')).rejects.toBe(refusal)
    expect(execMock).toHaveBeenCalledTimes(4)
  })

  it('does not retry non-session-limit exec open failures', async () => {
    const conn = new SshConnection(createTarget(), createCallbacks())
    await conn.connect()
    const failure = new Error('Not connected')
    const execMock = vi
      .fn<(cmd: string, cb: (err: Error | undefined, ch: unknown) => void) => void>()
      .mockImplementation((_cmd, cb) => cb(failure, undefined))
    clientInstances[0].exec = execMock as never

    await expect(conn.exec('printf ready')).rejects.toBe(failure)
    expect(execMock).toHaveBeenCalledTimes(1)
  })

  it('bounds an aborted exec to the close grace when ssh2 never invokes the open callback', async () => {
    const conn = new SshConnection(createTarget(), createCallbacks())
    await conn.connect()
    ssh2Mock.execBehavior = 'pending'
    const controller = new AbortController()

    vi.useFakeTimers()
    try {
      const outcomePromise = conn
        .exec('printf ready', { signal: controller.signal })
        .catch((error: Error) => error)

      controller.abort()
      // Why: a hung socket must not pin the aborted caller for the full 30s
      // connect timeout — the abort settles at the 5s grace bound instead.
      await vi.advanceTimersByTimeAsync(5_000)

      await expect(outcomePromise).resolves.toMatchObject({
        name: 'AbortError',
        sshChannelCloseConfirmed: false
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('drains an exec channel that opens after the abort grace has settled', async () => {
    const conn = new SshConnection(createTarget(), createCallbacks())
    await conn.connect()
    ssh2Mock.execBehavior = 'pending'
    const controller = new AbortController()
    const lateChannel = Object.assign(new EventEmitter(), {
      close: vi.fn(),
      resume: vi.fn(),
      stderr: { resume: vi.fn() }
    })

    vi.useFakeTimers()
    try {
      const outcomePromise = conn
        .exec('printf ready', { signal: controller.signal })
        .catch((error: Error) => error)

      controller.abort()
      await vi.advanceTimersByTimeAsync(5_000)
      const outcome = await outcomePromise
      expect(outcome).toMatchObject({
        name: 'AbortError',
        sshChannelCloseConfirmed: false
      })

      pendingExecCallback?.(undefined, lateChannel)

      expect(lateChannel.resume).toHaveBeenCalledTimes(1)
      expect(lateChannel.stderr.resume).toHaveBeenCalledTimes(1)
      expect(lateChannel.close).toHaveBeenCalledTimes(1)
      lateChannel.emit('close')
      expect(outcome).toMatchObject({ sshChannelCloseConfirmed: true })
    } finally {
      vi.useRealTimers()
    }
  })

  it('rejects without waiting out the backoff when aborted during a session-limit retry delay', async () => {
    const conn = new SshConnection(createTarget(), createCallbacks())
    await conn.connect()
    const controller = new AbortController()
    const refusal = Object.assign(new Error('(SSH) Channel open failure: open failed'), {
      reason: 2
    })
    const execMock = vi
      .fn<(cmd: string, cb: (err: Error | undefined, ch: unknown) => void) => void>()
      .mockImplementation((_cmd, cb) => cb(refusal, undefined))
    clientInstances[0].exec = execMock as never

    vi.useFakeTimers()
    try {
      const outcomePromise = conn
        .exec('printf ready', { signal: controller.signal })
        .then(() => 'opened')
        .catch((error: Error) => error.name)

      // Flush microtasks so the first refused attempt lands in the backoff.
      await vi.advanceTimersByTimeAsync(0)
      controller.abort()

      // No timer advance: the abort alone must release the backoff delay.
      await expect(outcomePromise).resolves.toBe('AbortError')
      expect(execMock).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('settles an abort during channel open only after the late channel closes', async () => {
    const conn = new SshConnection(createTarget(), createCallbacks())
    await conn.connect()
    ssh2Mock.execBehavior = 'pending'
    const controller = new AbortController()
    const lateChannel = Object.assign(new EventEmitter(), {
      close: vi.fn(),
      resume: vi.fn(),
      stderr: Object.assign(new EventEmitter(), { resume: vi.fn() })
    })

    const outcomePromise = conn
      .exec('printf ready', { signal: controller.signal })
      .then(() => 'opened')
      .catch((error: Error) => error.name)

    await Promise.resolve()
    controller.abort()
    pendingExecCallback?.(undefined, lateChannel)

    // Why: the sshd session slot is freed only when the channel finishes
    // closing — settling before 'close' lets the next open race the close.
    const early = await Promise.race([outcomePromise, Promise.resolve('pending')])
    expect(early).toBe('pending')
    expect(lateChannel.close).toHaveBeenCalledTimes(1)
    expect(lateChannel.resume).toHaveBeenCalled()
    expect(() => lateChannel.emit('error', new Error('late channel teardown'))).not.toThrow()
    expect(() => lateChannel.stderr.emit('error', new Error('late stderr teardown'))).not.toThrow()

    lateChannel.emit('close')
    await expect(outcomePromise).resolves.toBe('AbortError')
  })

  it('removes the late-channel close listener when abort grace expires', async () => {
    const conn = new SshConnection(createTarget(), createCallbacks())
    await conn.connect()
    vi.useFakeTimers()
    try {
      ssh2Mock.sftpBehavior = 'pending'
      const controller = new AbortController()
      const lateSftp = Object.assign(new EventEmitter(), { end: vi.fn() })

      const outcomePromise = conn
        .sftp(controller.signal)
        .then(() => 'opened')
        .catch((error: Error) => error.name)
      await vi.advanceTimersByTimeAsync(0)
      controller.abort()
      pendingSftpCallback?.(undefined, lateSftp)
      expect(lateSftp.listenerCount('close')).toBe(1)
      expect(() => lateSftp.emit('error', new Error('late SFTP teardown'))).not.toThrow()

      await vi.advanceTimersByTimeAsync(5_000)

      await expect(outcomePromise).resolves.toBe('AbortError')
      expect(lateSftp.listenerCount('close')).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('times out when ssh2 never opens an SFTP channel', async () => {
    const conn = new SshConnection(createTarget(), createCallbacks())
    await conn.connect()
    ssh2Mock.sftpBehavior = 'pending'

    vi.useFakeTimers()
    try {
      const outcomePromise = conn.sftp().catch((error: Error) => error)

      await vi.advanceTimersByTimeAsync(30_000)
      const outcome = await Promise.race([outcomePromise, Promise.resolve('pending')])

      expect(outcome).toMatchObject({ message: 'SSH SFTP channel timed out' })
      expect(outcome).not.toHaveProperty('sshChannelCloseConfirmed')
    } finally {
      vi.useRealTimers()
    }
  })

  it('ends a late SFTP callback after the channel-open timeout settles', async () => {
    const conn = new SshConnection(createTarget(), createCallbacks())
    await conn.connect()
    ssh2Mock.sftpBehavior = 'pending'
    const lateSftp = { end: vi.fn() }

    vi.useFakeTimers()
    try {
      const outcomePromise = conn
        .sftp()
        .then(() => 'opened')
        .catch((error: Error) => error.message)

      await vi.advanceTimersByTimeAsync(30_000)
      pendingSftpCallback?.(undefined, lateSftp)

      await expect(outcomePromise).resolves.toBe('SSH SFTP channel timed out')
      expect(lateSftp.end).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('cancels a pending SFTP channel open and ends the late channel', async () => {
    const conn = new SshConnection(createTarget(), createCallbacks())
    await conn.connect()
    ssh2Mock.sftpBehavior = 'pending'
    const controller = new AbortController()
    const lateSftp = { end: vi.fn() }

    const outcomePromise = conn
      .sftp({ signal: controller.signal })
      .then(() => 'opened')
      .catch((error: Error) => error.name)

    await Promise.resolve()
    controller.abort()
    pendingSftpCallback?.(undefined, lateSftp)

    await expect(outcomePromise).resolves.toBe('AbortError')
    expect(lateSftp.end).toHaveBeenCalledTimes(1)
  })

  it('removes the late SFTP close listener when the bounded grace expires', async () => {
    const conn = new SshConnection(createTarget(), createCallbacks())
    await conn.connect()
    ssh2Mock.sftpBehavior = 'pending'
    const controller = new AbortController()
    const lateSftp = Object.assign(new EventEmitter(), { end: vi.fn() })

    vi.useFakeTimers()
    try {
      const outcomePromise = conn
        .sftp({ signal: controller.signal })
        .then(() => 'opened')
        .catch((error: Error) => error.name)

      await Promise.resolve()
      controller.abort()
      pendingSftpCallback?.(undefined, lateSftp)
      expect(lateSftp.listenerCount('close')).toBe(1)

      await vi.advanceTimersByTimeAsync(5_000)

      await expect(outcomePromise).resolves.toBe('AbortError')
      expect(lateSftp.listenerCount('close')).toBe(0)
      expect(lateSftp.end).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })
})
