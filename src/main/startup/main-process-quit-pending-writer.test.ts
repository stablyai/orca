import { EventEmitter } from 'node:events'
import { afterEach, expect, it, vi } from 'vitest'
import { WILL_QUIT_TEARDOWN_DEADLINE_MS } from '../quit-teardown-deadline'

const settled = () => vi.fn(async () => {})
const idle = () => vi.fn()
const stopStructuredAgentSessionRuntime = settled()
const beginSshShutdown = settled()
const killAllPty = idle()
/** Final-save calls seen by the first microtask after the SSH shutdown began. */
let flushesByNextMicrotask = -1

afterEach(() => {
  vi.doUnmock('electron')
  vi.doUnmock('./main-process-state')
  vi.doUnmock('./main-process-connector-startup')
  vi.restoreAllMocks()
  vi.useRealTimers()
  vi.resetModules()
})

async function startQuit(
  flushFinalOrThrowAsync: () => Promise<void>,
  services: Record<string, unknown> = {}
) {
  beginSshShutdown.mockClear()
  killAllPty.mockClear()
  flushesByNextMicrotask = -1
  vi.resetModules()
  vi.useFakeTimers()
  const app = Object.assign(new EventEmitter(), { quit: vi.fn() })
  const admission = { release: vi.fn() }
  const store = {
    flushFinalOrThrowAsync: vi.fn(flushFinalOrThrowAsync),
    freezeWritesAsync: settled()
  }
  beginSshShutdown.mockImplementation(async () => {
    void Promise.resolve().then(() => {
      flushesByNextMicrotask = store.flushFinalOrThrowAsync.mock.calls.length
    })
  })
  const profileStateAdmission: typeof admission | undefined = admission
  const state = {
    isQuitting: false,
    watcherShutdownDone: true,
    store,
    profileStateAdmission,
    ...services
  }
  vi.doMock('electron', () => ({ app }))
  vi.doMock('./main-process-state', () => ({ mainProcessState: state }))
  vi.doMock('./main-process-connector-startup', () => ({ desktopConnectorCloud: () => null }))
  const { registerQuitTask } = await import('../quit-task-registry')
  registerQuitTask('ssh', 'ssh', beginSshShutdown)
  registerQuitTask('pty', 'pty', killAllPty)
  registerQuitTask('structured-sessions', 'structured-sessions', stopStructuredAgentSessionRuntime)
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  const { installMainProcessQuitHandlers } = await import('./main-process-quit')
  const { quitTeardownStartGate } = await import('../quit-teardown-start-gate')
  quitTeardownStartGate.resetForTests()
  installMainProcessQuitHandlers()
  app.emit('before-quit', { defaultPrevented: false })
  app.emit('will-quit', { preventDefault: vi.fn() })
  return { app, admission, store, state }
}

it('quits at the teardown deadline without releasing admission while the writer is pending', async () => {
  const { app, admission, store, state } = await startQuit(() => new Promise<void>(() => {}))
  await vi.advanceTimersByTimeAsync(WILL_QUIT_TEARDOWN_DEADLINE_MS - 1)
  expect(app.quit).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1)
  expect(app.quit).toHaveBeenCalledOnce()
  expect(console.warn).toHaveBeenCalledWith('[shutdown] Quit teardown deadline reached', {
    pendingTeardowns: ['state']
  })
  expect(store.flushFinalOrThrowAsync).toHaveBeenCalledOnce()
  expect(store.freezeWritesAsync).not.toHaveBeenCalled()
  expect(admission.release).not.toHaveBeenCalled()
  expect(state.profileStateAdmission).toBe(admission)
})

it('releases admission only after the final flush and freeze complete', async () => {
  const { app, admission, store } = await startQuit(async () => {})
  await vi.advanceTimersByTimeAsync(0)
  expect(store.freezeWritesAsync).toHaveBeenCalledOnce()
  expect(admission.release).toHaveBeenCalledOnce()
  expect(app.quit).toHaveBeenCalledOnce()
})

it('writes a pane grid still inside its write burst before the final flush', async () => {
  const paneGrids = Promise.withResolvers<void>()
  const { store } = await startQuit(async () => {}, {
    runtime: {
      getOffscreenBrowserBackend: () => null,
      getAgentBrowserBridge: () => null,
      getEmulatorBridge: () => null,
      disposeSkillUploadSessions: settled(),
      getRuntimeId: () => undefined,
      closeNotificationDismissals: settled(),
      flushPaneGrids: () => paneGrids.promise
    }
  })
  await vi.advanceTimersByTimeAsync(0)
  // Before the SSH shutdown too: nothing is awaited between it and the final save.
  expect(beginSshShutdown).not.toHaveBeenCalled()
  expect(store.flushFinalOrThrowAsync).not.toHaveBeenCalled()
  paneGrids.resolve()
  await vi.advanceTimersByTimeAsync(0)
  expect(beginSshShutdown).toHaveBeenCalledOnce()
  expect(store.flushFinalOrThrowAsync).toHaveBeenCalledOnce()
  expect(beginSshShutdown.mock.invocationCallOrder[0]).toBeLessThan(
    store.flushFinalOrThrowAsync.mock.invocationCallOrder[0]!
  )
  // Nothing awaited between them: the save started in the same turn as the SSH shutdown.
  expect(flushesByNextMicrotask).toBe(1)
})

it('starts the SSH shutdown and the final save at once when no pane grid waits', async () => {
  const { store } = await startQuit(async () => {})
  expect(beginSshShutdown).toHaveBeenCalledOnce()
  expect(store.flushFinalOrThrowAsync).toHaveBeenCalledOnce()
  const order = [beginSshShutdown, killAllPty, store.flushFinalOrThrowAsync].map(
    (step) => step.mock.invocationCallOrder[0]!
  )
  expect(order).toEqual([...order].sort((a, b) => a - b))
  await vi.advanceTimersByTimeAsync(0)
  expect(flushesByNextMicrotask).toBe(1)
})

it.each([
  ['chat teardown', 'RPC stop'],
  ['RPC stop', 'chat teardown']
] as const)(
  'closes notification dismissals only once %s and then %s settle',
  async (first, second) => {
    const sessionTeardown = Promise.withResolvers<void>()
    const rpcStop = Promise.withResolvers<void>()
    const release = { 'chat teardown': sessionTeardown.resolve, 'RPC stop': rpcStop.resolve }
    stopStructuredAgentSessionRuntime.mockClear()
    stopStructuredAgentSessionRuntime.mockImplementationOnce(() => sessionTeardown.promise)
    const closeNotificationDismissals = vi.fn(() => new Promise<void>(() => {}))
    const { app } = await startQuit(async () => {}, {
      runtime: {
        getOffscreenBrowserBackend: () => null,
        getAgentBrowserBridge: () => null,
        getEmulatorBridge: () => null,
        disposeSkillUploadSessions: settled(),
        getRuntimeId: () => undefined,
        closeNotificationDismissals,
        flushPaneGrids: () => null
      },
      runtimeRpc: { setMobileRelayPairingProvider: idle(), stop: vi.fn(() => rpcStop.promise) }
    })
    expect(stopStructuredAgentSessionRuntime).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(0)
    expect(closeNotificationDismissals).not.toHaveBeenCalled()
    release[first]()
    await vi.advanceTimersByTimeAsync(0)
    expect(closeNotificationDismissals).not.toHaveBeenCalled()
    release[second]()
    await vi.advanceTimersByTimeAsync(0)
    expect(closeNotificationDismissals).toHaveBeenCalledOnce()
    expect(app.quit).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(WILL_QUIT_TEARDOWN_DEADLINE_MS)
    expect(console.warn).toHaveBeenCalledWith('[shutdown] Quit teardown deadline reached', {
      pendingTeardowns: ['notification-dismissals']
    })
    expect(app.quit).toHaveBeenCalledOnce()
  }
)

it('does not restart cleanup while pending or after the final quit pass', async () => {
  const writer = Promise.withResolvers<void>()
  const { app, store } = await startQuit(() => writer.promise)
  const pendingQuit = { preventDefault: vi.fn() }
  app.emit('will-quit', pendingQuit)
  expect(pendingQuit.preventDefault).toHaveBeenCalledOnce()
  expect(store.flushFinalOrThrowAsync).toHaveBeenCalledOnce()
  writer.resolve()
  await vi.advanceTimersByTimeAsync(0)
  const finalQuit = { preventDefault: vi.fn() }
  app.emit('will-quit', finalQuit)
  expect(finalQuit.preventDefault).not.toHaveBeenCalled()
  expect(beginSshShutdown).toHaveBeenCalledOnce()
  expect(app.quit).toHaveBeenCalledOnce()
})

it('starts critical phases in shutdown order even when owners initialized in reverse order', async () => {
  const { app } = await startQuit(async () => {})
  // The first run is complete before installing a fresh handler/registry below.
  await vi.advanceTimersByTimeAsync(0)
  expect(app.quit).toHaveBeenCalledOnce()
  vi.resetModules()
  const { registerQuitTask } = await import('../quit-task-registry')
  const trace: string[] = []
  registerQuitTask('daemon', 'daemon', () => {
    trace.push('daemon')
  })
  registerQuitTask('base-directory-watchers', 'base-directory-watchers', () => {
    trace.push('base-watchers')
  })
  registerQuitTask('filesystem-watchers', 'filesystem-watchers', () => {
    trace.push('filesystem-watchers')
  })
  registerQuitTask('folder-watchers', 'folder-watchers', () => {
    trace.push('folder-watchers')
  })
  registerQuitTask('pty', 'pty', () => {
    trace.push('pty')
  })
  registerQuitTask('ssh', 'ssh', () => {
    trace.push('ssh')
  })
  registerQuitTask('hook-server', 'hook-server', () => {
    trace.push('hooks')
  })
  registerQuitTask('structured-sessions', 'structured-sessions', () => {
    trace.push('sessions')
  })
  registerQuitTask('codex-bridges', 'codex-bridges', () => {
    trace.push('codex-bridges')
  })
  registerQuitTask('codex-backfill', 'codex-backfill', () => {
    trace.push('codex-backfill')
  })
  const store = {
    flushFinalOrThrowAsync: async () => {
      trace.push('save')
    },
    freezeWritesAsync: settled()
  }
  vi.doMock('./main-process-state', () => ({ mainProcessState: { store } }))
  const { installMainProcessQuitHandlers } = await import('./main-process-quit')
  app.removeAllListeners()
  installMainProcessQuitHandlers()
  app.emit('will-quit', { preventDefault: vi.fn() })
  expect(trace).toEqual([
    'codex-backfill',
    'codex-bridges',
    'sessions',
    'hooks',
    'ssh',
    'pty',
    'folder-watchers',
    'filesystem-watchers',
    'base-watchers',
    'save',
    'daemon'
  ])
})

it('finishes notifications and quits after session and RPC shutdown failures', async () => {
  const failure = new Error('transport failed')
  vi.spyOn(console, 'error').mockImplementation(() => {})
  stopStructuredAgentSessionRuntime.mockImplementationOnce(() => Promise.reject(failure))
  const closeNotificationDismissals = settled()
  const { app } = await startQuit(async () => {}, {
    runtime: {
      getOffscreenBrowserBackend: () => null,
      getAgentBrowserBridge: () => null,
      getEmulatorBridge: () => null,
      disposeSkillUploadSessions: settled(),
      closeNotificationDismissals,
      flushPaneGrids: () => null
    },
    runtimeRpc: { setMobileRelayPairingProvider: idle(), stop: () => Promise.reject(failure) }
  })
  await vi.advanceTimersByTimeAsync(0)
  expect(closeNotificationDismissals).toHaveBeenCalledOnce()
  expect(app.quit).toHaveBeenCalledOnce()
})
