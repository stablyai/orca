import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { mockPtySpawn, mockPtyInstance, mockCreateShellPromptReadinessProbe } = vi.hoisted(() => ({
  mockPtySpawn: vi.fn(),
  mockCreateShellPromptReadinessProbe: vi.fn(),
  mockPtyInstance: {
    pid: process.pid,
    onData: vi.fn(),
    onExit: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    clear: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn()
  }
}))

vi.mock('node-pty', () => ({
  spawn: mockPtySpawn
}))

vi.mock('../main/pty/posix-pty-process-groups', () => ({
  forceKillPosixPtyProcessGroups: vi.fn((_pid: number, fallback: () => void) => fallback())
}))

vi.mock('../main/shell-prompt-readiness-probe', () => ({
  createShellPromptReadinessProbe: mockCreateShellPromptReadinessProbe
}))

import type { PtyHandler } from './pty-handler'
import * as ptyShellUtils from './pty-shell-utils'
import { beginPtyHandlerTest, endPtyHandlerTest, testPtyId } from './pty-handler-test-harness'
import type { MockDispatcher } from './pty-handler-test-harness'

const PTY_1 = testPtyId(1)
const STALE_PID = 424_242

/**
 * node-pty's native `pty.resize` error when the ioctl reaches a closed master.
 *
 * Orca's node-pty patch retires `_fd` when it gives up the master, so a patched
 * handle answers a late resize with a no-op. That leaves this handler two cases
 * it still has to contain: the tick between libuv closing the fd and node-pty's
 * own handler observing it, and a relay host, which installs node-pty from npm
 * and has no such guard.
 */
function ebadfResize(): never {
  throw new Error('ioctl(2) failed, EBADF')
}

describe('PtyHandler.resize against a stale PTY handle', () => {
  let dispatcher: MockDispatcher
  let handler: PtyHandler
  let originalPlatform: PropertyDescriptor | undefined
  let resize: ReturnType<typeof vi.fn>

  beforeEach(async () => {
    ;({ dispatcher, handler, originalPlatform } = beginPtyHandlerTest({
      mockPtySpawn,
      mockPtyInstance,
      mockCreateShellPromptReadinessProbe
    }))
    resize = vi.fn()
    // A shell that exited without node-pty producing `onExit`: the record is
    // still in the pool and undisposed, but the master behind it is gone.
    mockPtySpawn.mockReturnValue({ ...mockPtyInstance, pid: STALE_PID, resize })
    await dispatcher.callRequest('pty.spawn', {})
    expect(handler.activePtyCount).toBe(1)
  })

  afterEach(async () => {
    await endPtyHandlerTest(handler, originalPlatform)
  })

  it('retires an entry whose pid the host proves is gone, instead of issuing the ioctl', () => {
    vi.spyOn(ptyShellUtils, 'isProcessAlive').mockReturnValue(false)
    resize.mockImplementation(ebadfResize)

    expect(() =>
      dispatcher.callNotification('pty.resize', { id: PTY_1, cols: 120, rows: 40 })
    ).not.toThrow()

    expect(resize).not.toHaveBeenCalled()
    // The record must leave the pool: while it stays, the relay keeps
    // advertising a dead shell and `activePtyCount` never reaches zero, so a
    // relay configured with an unlimited grace never reaches its idle exit.
    expect(handler.activePtyCount).toBe(0)
  })

  it('contains an ioctl failure without re-classifying liveness, and keeps the record', () => {
    vi.spyOn(ptyShellUtils, 'isProcessAlive').mockReturnValue(true)
    resize.mockImplementation(ebadfResize)
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true)

    expect(() =>
      dispatcher.callNotification('pty.resize', { id: PTY_1, cols: 120, rows: 40 })
    ).not.toThrow()
    // Repeats must stay contained too — this is the notification the client
    // re-sends on every reconnect and every window resize.
    expect(() =>
      dispatcher.callNotification('pty.resize', { id: PTY_1, cols: 90, rows: 30 })
    ).not.toThrow()

    // Loss of an fd observed the handle, not the host that owns the pid, so it is
    // `unverifiable` and the claim is retained. Only the probe above retires.
    expect(handler.activePtyCount).toBe(1)
    expect(stderr.mock.calls.map(([line]) => String(line)).join('')).toContain(
      'ioctl(2) failed, EBADF'
    )
  })

  it('retires the entry when the pid goes absent between the pre-probe and the ioctl', () => {
    // The race the catch-block re-probe exists for, and the one a constant
    // liveness mock cannot express: alive when the pre-probe asks, gone by the
    // time the ioctl fails. libuv closes the master synchronously inside
    // `uv_close`, so this window opens before any JS guard can be set — and on
    // a relay host, where node-pty comes from npm, there is no JS guard at all.
    vi.spyOn(ptyShellUtils, 'isProcessAlive').mockReturnValueOnce(true).mockReturnValueOnce(false)
    resize.mockImplementation(ebadfResize)
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true)

    expect(() =>
      dispatcher.callNotification('pty.resize', { id: PTY_1, cols: 120, rows: 40 })
    ).not.toThrow()

    expect(resize).toHaveBeenCalledTimes(1)
    expect(handler.activePtyCount).toBe(0)
    // Proven `exited` retires silently; only live-or-unverifiable is reported.
    expect(stderr).not.toHaveBeenCalled()
  })

  it('publishes the exit so the client stops holding a pane on a retired session', () => {
    vi.spyOn(ptyShellUtils, 'isProcessAlive').mockReturnValue(false)

    dispatcher.callNotification('pty.resize', { id: PTY_1, cols: 120, rows: 40 })

    // Retiring the record without this leaves the pane mounted against a
    // session the relay has already forgotten: the next attach answers
    // `PTY "<id>" not found` and nothing before it explained why.
    expect(dispatcher._notifications).toContainEqual({
      method: 'pty.exit',
      params: { id: PTY_1, code: -1, incarnationId: expect.any(String) }
    })
  })

  it('does not republish an exit node-pty already reported', async () => {
    // The listing sweep also reaps entries the natural `onExit` left behind; a
    // second `pty.exit` would hand the client a duplicate carrying -1 in place
    // of the real status. That sweep retires off `managed.disposed`, which is
    // bookkeeping rather than liveness, so it never publishes a verdict at all.
    const onExit = mockPtyInstance.onExit.mock.calls.at(-1)?.[0] as (e: {
      exitCode: number
    }) => void
    onExit({ exitCode: 7 })
    await vi.runAllTimersAsync()
    vi.spyOn(ptyShellUtils, 'isProcessAlive').mockReturnValue(false)

    await dispatcher.callRequest('pty.listProcesses', {})

    const exits = dispatcher._notifications.filter(
      (notification) => notification.method === 'pty.exit'
    )
    expect(exits).toHaveLength(1)
    expect(exits[0]?.params).toMatchObject({ id: PTY_1, code: 7 })
  })

  it('still resizes a live PTY, with the clamped geometry', () => {
    vi.spyOn(ptyShellUtils, 'isProcessAlive').mockReturnValue(true)

    dispatcher.callNotification('pty.resize', { id: PTY_1, cols: 4_000, rows: 40 })

    expect(resize).toHaveBeenCalledWith(500, 40)
    expect(handler.activePtyCount).toBe(1)
  })
})
