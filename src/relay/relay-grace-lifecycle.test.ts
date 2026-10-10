import { afterEach, expect, it, vi } from 'vitest'
import type { RelayDispatcher } from '../wsl-guest/dispatcher'
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
    onRequest: vi.fn()
  }
  const disposeOwnedProcesses = vi.fn(async () => {})
  const reopenOwnedProcesses = vi.fn()
  const disposeExitOnlyServices = vi.fn(async () => {})
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
    reopenOwnedProcesses,
    disposeExitOnlyServices,
    disposeRuntime
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: process.exit never returns; the stub only records the call.
  const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)
  return {
    lifecycle,
    ptyHandler,
    dispatcher,
    disposeOwnedProcesses,
    reopenOwnedProcesses,
    disposeExitOnlyServices,
    disposeRuntime,
    exit,
    graceCallbacks
  }
}

it('exits after idle shutdown', async () => {
  const f = fixture()
  f.lifecycle.shutdown()
  await vi.waitFor(() => expect(f.exit).toHaveBeenCalledWith(0))
  expect(f.ptyHandler.dispose).toHaveBeenCalledOnce()
  expect(f.disposeOwnedProcesses).toHaveBeenCalledOnce()
  expect(f.disposeRuntime).toHaveBeenCalledOnce()
  expect(f.disposeExitOnlyServices).toHaveBeenCalledOnce()
  expect(f.reopenOwnedProcesses).not.toHaveBeenCalled()
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
  expect(f.reopenOwnedProcesses, 'a deferred relay serves again').toHaveBeenCalledOnce()

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

it('keeps every PTY when owned-process cleanup defers the shutdown', async () => {
  const f = fixture({ clients: 1 })
  f.disposeOwnedProcesses.mockRejectedValueOnce(new Error('agent child still closing'))
  f.lifecycle.shutdown()
  await vi.waitFor(() => expect(f.reopenOwnedProcesses).toHaveBeenCalledOnce())
  expect(f.ptyHandler.dispose).not.toHaveBeenCalled()
  expect(
    f.disposeExitOnlyServices,
    'AI Vault and skill uploads keep serving'
  ).not.toHaveBeenCalled()
  expect(f.exit).not.toHaveBeenCalled()
})
