import { afterEach, describe, expect, it, vi } from 'vitest'

import type { SshRelayRuntimePosixFileChannel } from './ssh-relay-runtime-posix-file-destination'
import {
  runSshRelayRuntimePosixControlCommand,
  SSH_RELAY_RUNTIME_POSIX_CONTROL_COMMAND_LIMITS
} from './ssh-relay-runtime-posix-control-command'

function createChannel(): {
  channel: SshRelayRuntimePosixFileChannel
  settle: (error?: unknown) => void
  end: ReturnType<typeof vi.fn<() => void>>
  requestClose: ReturnType<typeof vi.fn<() => void>>
  forceClose: ReturnType<typeof vi.fn<() => void>>
} {
  let resolveSettlement: (() => void) | undefined
  let rejectSettlement: ((error: unknown) => void) | undefined
  const settled = new Promise<void>((resolve, reject) => {
    resolveSettlement = resolve
    rejectSettlement = reject
  })
  const end = vi.fn()
  const requestClose = vi.fn()
  const forceClose = vi.fn()
  return {
    channel: Object.freeze({
      write: vi.fn(),
      end,
      settled,
      requestClose,
      forceClose
    }),
    settle: (error?: unknown) =>
      error === undefined ? resolveSettlement?.() : rejectSettlement?.(error),
    end,
    requestClose,
    forceClose
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('SSH relay runtime POSIX control command', () => {
  it('rejects invalid input and pre-abort before opening a channel', async () => {
    const openChannel = vi.fn()
    const controller = new AbortController()
    const reason = new Error('cancelled before control command')
    controller.abort(reason)

    await expect(
      runSshRelayRuntimePosixControlCommand({
        command: 'mkdir stage',
        signal: controller.signal,
        openChannel
      })
    ).rejects.toBe(reason)
    expect(openChannel).not.toHaveBeenCalled()

    await expect(
      runSshRelayRuntimePosixControlCommand({
        command: '',
        signal: new AbortController().signal,
        openChannel
      })
    ).rejects.toThrow(/input/i)
  })

  it('opens the exact command, ends stdin once, and awaits successful settlement', async () => {
    const fixture = createChannel()
    const controller = new AbortController()
    const removeAbortListener = vi.spyOn(controller.signal, 'removeEventListener')
    const openChannel = vi.fn(async () => fixture.channel)
    const running = runSshRelayRuntimePosixControlCommand({
      command: "umask 077; mkdir '/owned-stage'",
      signal: controller.signal,
      openChannel
    })

    await vi.waitFor(() => expect(fixture.end).toHaveBeenCalledOnce())
    expect(openChannel).toHaveBeenCalledWith("umask 077; mkdir '/owned-stage'", controller.signal)
    expect(await Promise.race([running.then(() => 'settled'), Promise.resolve('pending')])).toBe(
      'pending'
    )
    fixture.settle()
    await expect(running).resolves.toBeUndefined()
    expect(fixture.requestClose).not.toHaveBeenCalled()
    expect(fixture.forceClose).not.toHaveBeenCalled()
    expect(removeAbortListener).toHaveBeenCalledWith('abort', expect.any(Function))
  })

  it('propagates nonzero and channel errors without replacing them', async () => {
    for (const error of [new Error('exit 7'), new Error('channel failed')]) {
      const fixture = createChannel()
      const running = runSshRelayRuntimePosixControlCommand({
        command: 'mkdir stage',
        signal: new AbortController().signal,
        openChannel: async () => fixture.channel
      })
      await vi.waitFor(() => expect(fixture.end).toHaveBeenCalledOnce())
      fixture.settle(error)
      await expect(running).rejects.toBe(error)
    }
  })

  it('settles a mid-command abort gracefully before returning the exact reason', async () => {
    const fixture = createChannel()
    const controller = new AbortController()
    const reason = new Error('cancelled control command')
    fixture.requestClose.mockImplementation(() => fixture.settle())
    const running = runSshRelayRuntimePosixControlCommand({
      command: 'mkdir stage',
      signal: controller.signal,
      openChannel: async () => fixture.channel
    })

    await vi.waitFor(() => expect(fixture.end).toHaveBeenCalledOnce())
    controller.abort(reason)
    await expect(running).rejects.toBe(reason)
    expect(fixture.requestClose).toHaveBeenCalledOnce()
    expect(fixture.forceClose).not.toHaveBeenCalled()
  })

  it('forces an unsettled abort after the graceful window', async () => {
    vi.useFakeTimers()
    const fixture = createChannel()
    const controller = new AbortController()
    const reason = new Error('force cancelled control command')
    fixture.forceClose.mockImplementation(() => fixture.settle())
    const running = runSshRelayRuntimePosixControlCommand({
      command: 'mkdir stage',
      signal: controller.signal,
      openChannel: async () => fixture.channel
    })

    await vi.waitFor(() => expect(fixture.end).toHaveBeenCalledOnce())
    const rejection = expect(running).rejects.toBe(reason)
    controller.abort(reason)
    await vi.advanceTimersByTimeAsync(
      SSH_RELAY_RUNTIME_POSIX_CONTROL_COMMAND_LIMITS.gracefulCloseMs
    )
    await rejection
    expect(fixture.requestClose).toHaveBeenCalledOnce()
    expect(fixture.forceClose).toHaveBeenCalledOnce()
  })

  it('turns the command ceiling into bounded graceful cancellation', async () => {
    vi.useFakeTimers()
    const fixture = createChannel()
    fixture.requestClose.mockImplementation(() => fixture.settle())
    const running = runSshRelayRuntimePosixControlCommand({
      command: 'mkdir stage',
      signal: new AbortController().signal,
      openChannel: async () => fixture.channel
    })

    const rejection = expect(running).rejects.toThrow(/timed out/i)
    await vi.advanceTimersByTimeAsync(
      SSH_RELAY_RUNTIME_POSIX_CONTROL_COMMAND_LIMITS.commandTimeoutMs
    )
    await rejection
    expect(fixture.requestClose).toHaveBeenCalledOnce()
    expect(fixture.forceClose).not.toHaveBeenCalled()
  })

  it('fails closed at the forced-settlement ceiling and joins termination failures', async () => {
    vi.useFakeTimers()
    const fixture = createChannel()
    fixture.requestClose.mockImplementation(() => {
      throw new Error('graceful close failed')
    })
    fixture.forceClose.mockImplementation(() => {
      throw new Error('forced close failed')
    })
    const controller = new AbortController()
    const reason = new Error('cancelled forever')
    const running = runSshRelayRuntimePosixControlCommand({
      command: 'mkdir stage',
      signal: controller.signal,
      openChannel: async () => fixture.channel
    })

    controller.abort(reason)
    const rejection = expect(running).rejects.toMatchObject({
      errors: expect.arrayContaining([
        reason,
        expect.objectContaining({ message: 'graceful close failed' }),
        expect.objectContaining({ message: 'forced close failed' }),
        expect.objectContaining({ message: expect.stringMatching(/settlement timed out/i) })
      ])
    })
    await vi.advanceTimersByTimeAsync(SSH_RELAY_RUNTIME_POSIX_CONTROL_COMMAND_LIMITS.totalCloseMs)
    await rejection
  })
})
