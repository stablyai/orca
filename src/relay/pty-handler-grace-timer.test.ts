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
import { RelayGraceLifecycle } from './relay-grace-lifecycle'
import type { RelayDispatcher } from './dispatcher'

function createGraceLifecycle(dispatcher: MockDispatcher, handler: PtyHandler, clients = 0) {
  return new RelayGraceLifecycle({
    dispatcher: Object.assign(dispatcher, {
      beginWorkDrain: vi.fn(async () => {})
    }) as unknown as RelayDispatcher,
    ptyHandler: handler,
    detached: true,
    emptyDetachedStartupGraceMs: 100,
    idleRelayGraceMs: 100,
    readSocketClientCount: () => clients,
    hasAcceptedSocketClient: () => true,
    ownsSocketPath: () => true,
    disposeOwnedProcesses: vi.fn(async () => {}),
    disposeRuntime: vi.fn()
  })
}

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

  it('defers source grace expiry while a live transfer fence exists, then resumes after unfencing', async () => {
    const spawned = (await dispatcher.callRequest('pty.spawn', {})) as { id: string }
    handler.setGraceTimeMs(100)
    handler.setOwnershipTransferMutationEnabled(true)
    const dormant = await dispatcher.callRequest('pty.getOwnershipBridgeCapabilities', {})
    expect(dormant).not.toHaveProperty('transferGraceGuardVersion')
    expect(dormant).not.toHaveProperty('transferLifecycleGuardVersion')
    const lifecycle = createGraceLifecycle(dispatcher, handler)
    const shutdown = vi.spyOn(lifecycle, 'shutdown').mockImplementation(() => {})
    expect(await dispatcher.callRequest('pty.getOwnershipBridgeCapabilities', {})).toMatchObject({
      transferGraceGuardVersion: 1,
      transferLifecycleGuardVersion: 1
    })
    lifecycle.start('source disconnected')
    handler.setOwnershipTransferInputFenced(spawned.id, true)
    vi.advanceTimersByTime(300)
    expect(handler.hasLiveOwnershipTransferFence).toBe(true)
    expect(shutdown).not.toHaveBeenCalled()
    expect(mockPtyInstance.kill).not.toHaveBeenCalled()
    expect(handler.activePtyCount).toBe(1)
    expect(lifecycle.reason).toBe('ownership transfer active')
    handler.setOwnershipTransferInputFenced(spawned.id, false)
    vi.advanceTimersByTime(100)
    expect(handler.hasLiveOwnershipTransferFence).toBe(false)
    expect(shutdown).toHaveBeenCalledOnce()
    handler.setOwnershipTransferMutationEnabled(false)
    const disabled = await dispatcher.callRequest('pty.getOwnershipBridgeCapabilities', {})
    expect(disabled).not.toHaveProperty('transferGraceGuardVersion')
    expect(disabled).not.toHaveProperty('transferLifecycleGuardVersion')
  })

  it.each([0, 1])(
    'defers explicit lifecycle shutdown without partial disposal with %s clients',
    async (clients) => {
      const spawned = (await dispatcher.callRequest('pty.spawn', {})) as { id: string }
      handler.setGraceTimeMs(100)
      handler.setOwnershipTransferInputFenced(spawned.id, true)
      const lifecycle = createGraceLifecycle(dispatcher, handler, clients)
      const dispose = vi.spyOn(handler, 'dispose')
      lifecycle.shutdown()
      lifecycle.shutdown()
      expect(dispose).not.toHaveBeenCalled()
      expect(mockPtyInstance.kill).not.toHaveBeenCalled()
      expect(handler.writeOwnershipTransferInput(spawned.id, 'still-owned')).toBe(true)
      await expect(dispatcher.callRequest('pty.spawn', {})).resolves.toHaveProperty('id')
      expect(handler.graceTimerActive).toBe(clients === 0)
      handler.setOwnershipTransferInputFenced(spawned.id, false)
      dispose.mockRejectedValueOnce(new Error('test disposal deferred'))
      lifecycle.shutdown()
      await vi.advanceTimersByTimeAsync(0)
      expect(dispose).toHaveBeenCalledOnce()
      lifecycle.cancel('test complete')
      dispose.mockRestore()
    }
  )

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
