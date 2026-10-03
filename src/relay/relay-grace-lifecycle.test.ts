import { afterEach, expect, it, vi } from 'vitest'
import type { RelayDispatcher, RequestContext } from './dispatcher'
import type { PtyHandler } from './pty-handler'
import { RelayGraceLifecycle } from './relay-grace-lifecycle'

afterEach(() => {
  vi.restoreAllMocks()
})

function fixture(options: { clients?: number; dispose?: () => Promise<void> } = {}) {
  const graceCallbacks: (() => void)[] = []
  const ptyHandler = {
    configuredGraceTimeMs: 1_000,
    activePtyCount: 0,
    pendingPtyCreationCount: 0,
    graceTimerActive: false,
    startGraceTimer: vi.fn((callback: () => void) => graceCallbacks.push(callback)),
    cancelGraceTimer: vi.fn(),
    onPtyPoolEmpty: vi.fn(() => () => {}),
    onPtyPoolActive: vi.fn(() => () => {}),
    dispose: vi.fn(options.dispose ?? (async () => {}))
  }
  const dispatcher = {
    onNotification: vi.fn(),
    onRequest: vi.fn(),
    assertActiveWorkContext: vi.fn(),
    beginWorkDrain: vi.fn(async () => {})
  }
  const disposeOwnedProcesses = vi.fn(async () => {})
  const disposeRuntime = vi.fn()
  const lifecycle = new RelayGraceLifecycle({
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the stub implements every dispatcher member the lifecycle calls.
    dispatcher: dispatcher as unknown as RelayDispatcher,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the stub implements every PTY handler member the lifecycle calls.
    ptyHandler: ptyHandler as unknown as PtyHandler,
    detached: true,
    emptyDetachedStartupGraceMs: 100,
    idleRelayGraceMs: 100,
    readSocketClientCount: () => options.clients ?? 0,
    hasAcceptedSocketClient: () => false,
    ownsSocketPath: () => true,
    disposeOwnedProcesses,
    disposeRuntime
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: process.exit never returns; the stub only records the call.
  const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)
  return {
    lifecycle,
    ptyHandler,
    dispatcher,
    disposeOwnedProcesses,
    disposeRuntime,
    exit,
    graceCallbacks
  }
}

it('exits after idle shutdown without waiting on admitted requests', async () => {
  const f = fixture()
  f.lifecycle.shutdown()
  await vi.waitFor(() => expect(f.exit).toHaveBeenCalledWith(0))
  expect(f.ptyHandler.dispose).toHaveBeenCalledOnce()
  expect(f.disposeOwnedProcesses).toHaveBeenCalledOnce()
  expect(f.disposeRuntime).toHaveBeenCalledOnce()
  expect(f.dispatcher.beginWorkDrain).not.toHaveBeenCalled()
})

it('defers a failed idle shutdown and retries it through the grace timer', async () => {
  let attempts = 0
  const f = fixture({
    dispose: async () => {
      attempts += 1
      if (attempts === 1) {
        throw new Error('pty still exiting')
      }
    }
  })
  vi.spyOn(console, 'error').mockImplementation(() => {})
  f.lifecycle.shutdown()
  await vi.waitFor(() => expect(f.ptyHandler.startGraceTimer).toHaveBeenCalledOnce())
  expect(f.lifecycle.reason).toBe('shutdown deferred')
  expect(f.exit).not.toHaveBeenCalled()

  f.graceCallbacks[0]()
  await vi.waitFor(() => expect(f.exit).toHaveBeenCalledWith(0))
  expect(f.ptyHandler.dispose).toHaveBeenCalledTimes(2)
})

it('does not retry a deferred shutdown while a socket client is attached', async () => {
  const f = fixture({
    clients: 1,
    dispose: async () => {
      throw new Error('pty still exiting')
    }
  })
  f.lifecycle.shutdown()
  await vi.waitFor(() => expect(f.ptyHandler.dispose).toHaveBeenCalledOnce())
  await Promise.resolve()
  expect(f.ptyHandler.startGraceTimer).not.toHaveBeenCalled()
  expect(f.exit).not.toHaveBeenCalled()
})

it('keeps the transport up until a reset initiator finishes, draining around owned disposal', async () => {
  const f = fixture()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the lifecycle only forwards the initiator to the dispatcher stub.
  const initiator = { clientId: 1 } as RequestContext
  await f.lifecycle.prepareShutdown(initiator)
  expect(f.dispatcher.assertActiveWorkContext).toHaveBeenCalledWith(initiator)
  expect(f.dispatcher.beginWorkDrain).toHaveBeenCalledTimes(2)
  expect(f.dispatcher.beginWorkDrain).toHaveBeenCalledWith(initiator)
  expect(f.disposeOwnedProcesses).toHaveBeenCalledOnce()
  expect(f.disposeRuntime).not.toHaveBeenCalled()
  expect(f.exit).not.toHaveBeenCalled()

  f.lifecycle.finishShutdown()
  expect(f.disposeRuntime).toHaveBeenCalledOnce()
  expect(f.exit).toHaveBeenCalledWith(0)
})

it('joins the same initiator, refuses a different one, and requires preparation to finish', async () => {
  const f = fixture()
  expect(() => f.lifecycle.finishShutdown()).toThrow('relay_shutdown_preparation_required')
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the lifecycle only forwards the initiator to the dispatcher stub.
  const initiator = { clientId: 1 } as RequestContext
  const first = f.lifecycle.prepareShutdown(initiator)
  expect(f.lifecycle.prepareShutdown(initiator)).toBe(first)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the lifecycle only forwards the initiator to the dispatcher stub.
  const other = { clientId: 2 } as RequestContext
  await expect(f.lifecycle.prepareShutdown(other)).rejects.toThrow(
    'relay_shutdown_preparation_in_progress'
  )
  await first
  expect(f.ptyHandler.dispose).toHaveBeenCalledOnce()
})

it('lets a failed reset preparation be retried', async () => {
  let attempts = 0
  const f = fixture({
    dispose: async () => {
      attempts += 1
      if (attempts === 1) {
        throw new Error('pty still exiting')
      }
    }
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the lifecycle only forwards the initiator to the dispatcher stub.
  const initiator = { clientId: 1 } as RequestContext
  await expect(f.lifecycle.prepareShutdown(initiator)).rejects.toThrow('pty still exiting')
  expect(f.disposeOwnedProcesses).not.toHaveBeenCalled()
  await f.lifecycle.prepareShutdown(initiator)
  expect(f.disposeOwnedProcesses).toHaveBeenCalledOnce()
})
