import { describe, expect, it, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'
import {
  clientInstances,
  pendingExecCallback,
  pendingSftpCallback,
  ssh2Mock
} from './testing/ssh-connection-test-client'
import { resetSshConnectionMocks } from './testing/ssh-connection-test-harness'
import { createCallbacks, createTarget } from './testing/ssh-connection-test-fixtures'
import { SshConnection } from './ssh-connection'

vi.mock('../authentication/ssh2-module-load', async () =>
  (await import('./testing/ssh-connection-test-client')).createSsh2LoaderModule()
)
vi.mock('../system-transport/system-ssh-binary', async () =>
  (await import('./testing/ssh-connection-test-harness')).createSystemSshBinaryModule()
)
vi.mock('../system-transport/system-ssh-args', async (importOriginal) =>
  (await import('./testing/ssh-connection-test-harness')).withSystemSshArgsMocks(
    await importOriginal()
  )
)
vi.mock('../system-transport/system-ssh-command', async (importOriginal) =>
  (await import('./testing/ssh-connection-test-harness')).withSystemSshCommandMocks(
    await importOriginal()
  )
)
vi.mock(
  '../system-transport/file-transfer/system-ssh-file-binary-transfer',
  async (importOriginal) =>
    (await import('./testing/ssh-connection-test-harness')).withSystemSshFileBinaryTransferMocks(
      await importOriginal()
    )
)
vi.mock('../system-transport/file-transfer/system-ssh-file-transfer', async (importOriginal) =>
  (await import('./testing/ssh-connection-test-harness')).withSystemSshFileTransferMocks(
    await importOriginal()
  )
)
vi.mock('../system-transport/ssh-control-socket', async () =>
  (await import('./testing/ssh-connection-test-harness')).createControlSocketModule()
)
vi.mock('../config/ssh-config-parser', async () =>
  (await import('./testing/ssh-connection-test-harness')).createSshConfigParserModule()
)
vi.mock('../config/ssh-g-config-resolution', async (importOriginal) =>
  (await import('./testing/ssh-connection-test-harness')).withSshGConfigResolutionMocks(
    await importOriginal()
  )
)

describe('SshConnection', () => {
  beforeEach(() => {
    resetSshConnectionMocks()
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
      // Abort must settle at5s grace, not wait out the30s hung connect.
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

    // Session slots remain occupied until physical channel close; early settlement races the next open.
    const early = await Promise.race([outcomePromise, Promise.resolve('pending')])
    expect(early).toBe('pending')
    expect(lateChannel.close).toHaveBeenCalledTimes(1)
    expect(lateChannel.resume).toHaveBeenCalled()
    expect(() => lateChannel.emit('error', new Error('late channel teardown'))).not.toThrow()
    expect(() => lateChannel.stderr.emit('error', new Error('late stderr teardown'))).not.toThrow()

    lateChannel.emit('close')
    await expect(outcomePromise).resolves.toBe('AbortError')
  })

  it('removes the abort-grace waiter while retaining physical-close tracking', async () => {
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
      expect(lateSftp.listenerCount('close')).toBe(2)
      expect(() => lateSftp.emit('error', new Error('late SFTP teardown'))).not.toThrow()

      await vi.advanceTimersByTimeAsync(5_000)

      await expect(outcomePromise).resolves.toBe('AbortError')
      expect(lateSftp.listenerCount('close')).toBe(1)
      lateSftp.emit('close')
      expect(lateSftp.listenerCount('close')).toBe(0)
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
})
