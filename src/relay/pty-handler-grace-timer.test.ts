import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { DEFAULT_BOUNDED_SSH_RELAY_GRACE_PERIOD_SECONDS } from '../shared/ssh-types'

const { mockPtySpawn, mockPtyInstance, mockCreateShellPromptReadinessProbe } = vi.hoisted(() => ({
  mockPtySpawn: vi.fn(),
  mockCreateShellPromptReadinessProbe: vi.fn(),
  mockPtyInstance: {
    // Why: attach now proves the backing pid is alive before replaying, so the
    // default managed PTY must report a live pid. Reuse the test runner's own
    // pid — always alive — so unrelated attach tests are not seen as dead.
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
import { beginPtyHandlerTest, endPtyHandlerTest } from './pty-handler-test-harness'
import type { MockDispatcher } from './pty-handler-test-harness'

describe('PtyHandler', () => {
  let dispatcher: MockDispatcher
  let handler: PtyHandler
  let originalPlatform: PropertyDescriptor | undefined

  beforeEach(() => {
    ;({ dispatcher, handler, originalPlatform } = beginPtyHandlerTest({
      mockPtySpawn,
      mockPtyInstance,
      mockCreateShellPromptReadinessProbe
    }))
  })

  afterEach(async () => {
    await endPtyHandlerTest(handler, originalPlatform)
  })

  it('allows callers to shorten a grace timer for empty startup relays', () => {
    const onExpire = vi.fn()
    handler.startGraceTimer(onExpire, 100)

    expect(handler.graceTimerActive).toBe(true)
    vi.advanceTimersByTime(99)
    expect(onExpire).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(onExpire).toHaveBeenCalledTimes(1)
  })

  it('does not expire an unlimited grace timer', () => {
    const onExpire = vi.fn()
    handler.startGraceTimer(onExpire, 100)

    expect(handler.graceTimerActive).toBe(true)
    handler.startGraceTimer(onExpire, 0)

    expect(handler.graceTimerActive).toBe(false)
    vi.advanceTimersByTime(100)
    expect(onExpire).not.toHaveBeenCalled()
  })

  it('uses the configured grace time for future disconnect timers', () => {
    const onExpire = vi.fn()

    handler.setGraceTimeMs(250)
    handler.startGraceTimer(onExpire)

    vi.advanceTimersByTime(249)
    expect(onExpire).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(onExpire).toHaveBeenCalledTimes(1)
  })

  it('default grace timer does not expire', () => {
    const onExpire = vi.fn()

    handler.startGraceTimer(onExpire)

    expect(handler.graceTimerActive).toBe(false)
    vi.advanceTimersByTime(DEFAULT_BOUNDED_SSH_RELAY_GRACE_PERIOD_SECONDS * 1000)
    expect(onExpire).not.toHaveBeenCalled()
  })

  it('configured grace timer waits full period even when no PTYs exist', () => {
    const onExpire = vi.fn()
    const boundedGraceMs = DEFAULT_BOUNDED_SSH_RELAY_GRACE_PERIOD_SECONDS * 1000
    handler.setGraceTimeMs(boundedGraceMs)
    handler.startGraceTimer(onExpire)
    expect(onExpire).not.toHaveBeenCalled()
    vi.advanceTimersByTime(boundedGraceMs - 1)
    expect(onExpire).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(onExpire).toHaveBeenCalledTimes(1)
  })

  it('grace timer fires after configured delay when PTYs exist', async () => {
    mockPtySpawn.mockReturnValue({
      ...mockPtyInstance,
      onData: vi.fn(),
      onExit: vi.fn()
    })
    await dispatcher.callRequest('pty.spawn', {})

    const onExpire = vi.fn()
    const boundedGraceMs = DEFAULT_BOUNDED_SSH_RELAY_GRACE_PERIOD_SECONDS * 1000
    handler.setGraceTimeMs(boundedGraceMs)
    handler.startGraceTimer(onExpire)
    expect(onExpire).not.toHaveBeenCalled()

    vi.advanceTimersByTime(boundedGraceMs - 1)
    expect(onExpire).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(onExpire).toHaveBeenCalledTimes(1)
  })

  it('cancelGraceTimer prevents expiration', async () => {
    mockPtySpawn.mockReturnValue({
      ...mockPtyInstance,
      onData: vi.fn(),
      onExit: vi.fn()
    })
    await dispatcher.callRequest('pty.spawn', {})

    const onExpire = vi.fn()
    const boundedGraceMs = DEFAULT_BOUNDED_SSH_RELAY_GRACE_PERIOD_SECONDS * 1000
    handler.setGraceTimeMs(boundedGraceMs)
    handler.startGraceTimer(onExpire)

    vi.advanceTimersByTime(60_000)
    handler.cancelGraceTimer()

    vi.advanceTimersByTime(boundedGraceMs)
    expect(onExpire).not.toHaveBeenCalled()
  })
})
