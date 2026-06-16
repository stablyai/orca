/* eslint-disable max-lines -- Why: StarNagService tests share one mocked
Electron/IPC harness; splitting the narrow service suite would duplicate setup
and make the prompt-session edge cases harder to compare. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { STAR_NAG_INITIAL_THRESHOLD } from '../../shared/constants'
import type { PersistedUIState } from '../../shared/types'
import type { Store } from '../persistence'
import type { StatsCollector } from '../stats/collector'
import { StarNagService } from './service'

type TestWindow = {
  isDestroyed: () => boolean
  webContents: { send: ReturnType<typeof vi.fn> }
}

const {
  appMock,
  browserWindowMock,
  checkOrcaStarredMock,
  starOrcaMock,
  trackMock,
  getCohortAtEmitMock,
  ipcMainHandleMock
} = vi.hoisted(() => ({
  appMock: {
    getVersion: vi.fn(() => '1.2.3')
  },
  browserWindowMock: {
    getAllWindows: vi.fn<() => TestWindow[]>(() => [])
  },
  checkOrcaStarredMock: vi.fn(),
  starOrcaMock: vi.fn(),
  trackMock: vi.fn(),
  getCohortAtEmitMock: vi.fn(() => ({ nth_repo_added: 3 })),
  ipcMainHandleMock: vi.fn()
}))

vi.mock('electron', () => ({
  app: appMock,
  BrowserWindow: browserWindowMock,
  ipcMain: {
    handle: ipcMainHandleMock
  }
}))

vi.mock('../github/client', () => ({
  checkOrcaStarred: checkOrcaStarredMock,
  starOrca: starOrcaMock
}))

vi.mock('../telemetry/client', () => ({
  track: trackMock
}))

vi.mock('../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: getCohortAtEmitMock
}))

type AgentStartedListener = (totalAgentsSpawned: number) => void
type IpcHandler = () => unknown

type TestHarness = {
  service: StarNagService
  store: Store
  ui: PersistedUIState
  emitAgentStarted: (totalAgentsSpawned: number) => void
}

function createWindow(): TestWindow {
  return {
    isDestroyed: () => false,
    webContents: {
      send: vi.fn()
    }
  }
}

function createHarness(initialUI: Partial<PersistedUIState> = {}): TestHarness {
  let totalAgentsSpawned = 45
  const listeners: AgentStartedListener[] = []
  const ui = {
    starNagAppVersion: '1.2.3',
    starNagBaselineAgents: 10,
    starNagNextThreshold: STAR_NAG_INITIAL_THRESHOLD,
    ...initialUI
  } as PersistedUIState
  const store = {
    getUI: vi.fn(() => ui),
    updateUI: vi.fn((updates: Partial<PersistedUIState>) => {
      Object.assign(ui, updates)
    })
  } as unknown as Store
  const stats = {
    onAgentStarted: vi.fn((listener: AgentStartedListener) => {
      listeners.push(listener)
      return () => {
        const index = listeners.indexOf(listener)
        if (index !== -1) {
          listeners.splice(index, 1)
        }
      }
    }),
    getTotalAgentsSpawned: vi.fn(() => totalAgentsSpawned)
  } as unknown as StatsCollector

  return {
    service: new StarNagService(store, stats),
    store,
    ui,
    emitAgentStarted: (nextTotal: number) => {
      totalAgentsSpawned = nextTotal
      for (const listener of listeners) {
        listener(nextTotal)
      }
    }
  }
}

function createDeferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
} {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve
  })
  return { promise, resolve }
}

function getIpcHandler(channel: string): IpcHandler {
  const call = ipcMainHandleMock.mock.calls.find(
    ([registeredChannel]) => registeredChannel === channel
  )
  if (!call) {
    throw new Error(`missing IPC handler for ${channel}`)
  }
  return call[1] as IpcHandler
}

async function flushAsyncWork(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve))
}

describe('StarNagService', () => {
  let consoleInfoMock: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    appMock.getVersion.mockReset()
    appMock.getVersion.mockReturnValue('1.2.3')
    browserWindowMock.getAllWindows.mockReset()
    browserWindowMock.getAllWindows.mockReturnValue([])
    checkOrcaStarredMock.mockReset()
    checkOrcaStarredMock.mockResolvedValue(false)
    starOrcaMock.mockReset()
    starOrcaMock.mockResolvedValue(true)
    trackMock.mockReset()
    getCohortAtEmitMock.mockReset()
    getCohortAtEmitMock.mockReturnValue({ nth_repo_added: 3 })
    ipcMainHandleMock.mockReset()
    consoleInfoMock = vi.spyOn(console, 'info').mockImplementation(() => undefined)
  })

  afterEach(() => {
    consoleInfoMock.mockRestore()
  })

  it('logs a threshold exposure exactly once while the card remains visible', async () => {
    const window = createWindow()
    browserWindowMock.getAllWindows.mockReturnValue([window])
    const { service, emitAgentStarted } = createHarness()

    service.start()
    emitAgentStarted(45)
    await flushAsyncWork()
    emitAgentStarted(46)

    expect(window.webContents.send).toHaveBeenCalledTimes(1)
    expect(window.webContents.send).toHaveBeenCalledWith('star-nag:show', {
      mode: 'gh'
    })
    expect(consoleInfoMock).toHaveBeenCalledTimes(1)
    expect(consoleInfoMock).toHaveBeenCalledWith({
      event: 'star_nag_shown',
      app_version: '1.2.3',
      threshold: STAR_NAG_INITIAL_THRESHOLD,
      agents_since_baseline: 35,
      source: 'threshold'
    })
  })

  it('shows the browser fallback when checkOrcaStarred cannot determine star state', async () => {
    const window = createWindow()
    browserWindowMock.getAllWindows.mockReturnValue([window])
    checkOrcaStarredMock.mockResolvedValue(null)
    const { service, emitAgentStarted } = createHarness()

    service.start()
    emitAgentStarted(45)
    await flushAsyncWork()

    expect(window.webContents.send).toHaveBeenCalledWith('star-nag:show', {
      mode: 'web'
    })
    expect(trackMock).toHaveBeenCalledWith('star_nag_outcome', {
      outcome: 'shown',
      source: 'threshold',
      mode: 'web',
      threshold: STAR_NAG_INITIAL_THRESHOLD,
      agents_since_baseline: 35,
      agents_since_baseline_bucket: '35-69',
      nth_repo_added: 3
    })
    expect(consoleInfoMock).toHaveBeenCalledWith({
      event: 'star_nag_shown',
      app_version: '1.2.3',
      threshold: STAR_NAG_INITIAL_THRESHOLD,
      agents_since_baseline: 35,
      source: 'threshold'
    })
  })

  it('does not log a threshold exposure when checkOrcaStarred returns true', async () => {
    const window = createWindow()
    browserWindowMock.getAllWindows.mockReturnValue([window])
    checkOrcaStarredMock.mockResolvedValue(true)
    const { service, emitAgentStarted } = createHarness()

    service.start()
    emitAgentStarted(45)
    await flushAsyncWork()

    expect(window.webContents.send).not.toHaveBeenCalled()
    expect(consoleInfoMock).not.toHaveBeenCalled()
  })

  it('does not block a later real prompt after crossing the threshold with no window', async () => {
    const { service, emitAgentStarted } = createHarness()

    service.start()
    emitAgentStarted(45)
    await flushAsyncWork()

    expect(consoleInfoMock).not.toHaveBeenCalled()
    expect(trackMock).not.toHaveBeenCalled()

    const window = createWindow()
    browserWindowMock.getAllWindows.mockReturnValue([window])
    emitAgentStarted(46)
    await flushAsyncWork()

    expect(window.webContents.send).toHaveBeenCalledWith('star-nag:show', {
      mode: 'gh'
    })
    expect(consoleInfoMock).toHaveBeenCalledWith({
      event: 'star_nag_shown',
      app_version: '1.2.3',
      threshold: STAR_NAG_INITIAL_THRESHOLD,
      agents_since_baseline: 36,
      source: 'threshold'
    })
  })

  it('logs dismissal with doubled next_threshold and advances backoff for the active session', async () => {
    const window = createWindow()
    browserWindowMock.getAllWindows.mockReturnValue([window])
    const { service, emitAgentStarted, ui } = createHarness()

    service.start()
    service.registerIpcHandlers()
    emitAgentStarted(45)
    await flushAsyncWork()
    getIpcHandler('star-nag:dismiss')()

    expect(consoleInfoMock).toHaveBeenLastCalledWith({
      event: 'star_nag_dismissed',
      app_version: '1.2.3',
      threshold: STAR_NAG_INITIAL_THRESHOLD,
      agents_since_baseline: 35,
      source: 'threshold',
      next_threshold: STAR_NAG_INITIAL_THRESHOLD * 2
    })
    expect(ui.starNagNextThreshold).toBe(STAR_NAG_INITIAL_THRESHOLD * 2)
    expect(ui.starNagBaselineAgents).toBe(45)
  })

  it('keeps the force_show source through exposure and dismissal', () => {
    const window = createWindow()
    browserWindowMock.getAllWindows.mockReturnValue([window])
    const { service, ui } = createHarness()

    service.registerIpcHandlers()
    getIpcHandler('star-nag:forceShow')()
    getIpcHandler('star-nag:dismiss')()

    expect(consoleInfoMock).toHaveBeenNthCalledWith(1, {
      event: 'star_nag_shown',
      app_version: '1.2.3',
      threshold: STAR_NAG_INITIAL_THRESHOLD,
      agents_since_baseline: 35,
      source: 'force_show'
    })
    expect(consoleInfoMock).toHaveBeenNthCalledWith(2, {
      event: 'star_nag_dismissed',
      app_version: '1.2.3',
      threshold: STAR_NAG_INITIAL_THRESHOLD,
      agents_since_baseline: 35,
      source: 'force_show',
      next_threshold: STAR_NAG_INITIAL_THRESHOLD * 2
    })
    expect(ui.starNagNextThreshold).toBe(STAR_NAG_INITIAL_THRESHOLD * 2)
  })

  it('does not log or block a later force_show when no window exists', () => {
    const { service } = createHarness()

    service.registerIpcHandlers()
    const forceShow = getIpcHandler('star-nag:forceShow')
    forceShow()

    expect(consoleInfoMock).not.toHaveBeenCalled()

    const window = createWindow()
    browserWindowMock.getAllWindows.mockReturnValue([window])
    forceShow()

    expect(window.webContents.send).toHaveBeenCalledWith('star-nag:show', {
      mode: 'gh'
    })
    expect(consoleInfoMock).toHaveBeenCalledWith({
      event: 'star_nag_shown',
      app_version: '1.2.3',
      threshold: STAR_NAG_INITIAL_THRESHOLD,
      agents_since_baseline: 35,
      source: 'force_show'
    })
  })

  it('keeps threshold source when force_show is requested during a successful threshold evaluation', async () => {
    const window = createWindow()
    browserWindowMock.getAllWindows.mockReturnValue([window])
    const deferredStarCheck = createDeferred<boolean | null>()
    checkOrcaStarredMock.mockReturnValue(deferredStarCheck.promise)
    const { service, emitAgentStarted } = createHarness()

    service.start()
    service.registerIpcHandlers()
    emitAgentStarted(45)
    getIpcHandler('star-nag:forceShow')()

    expect(window.webContents.send).not.toHaveBeenCalled()
    expect(consoleInfoMock).not.toHaveBeenCalled()

    deferredStarCheck.resolve(false)
    await flushAsyncWork()

    expect(window.webContents.send).toHaveBeenCalledTimes(1)
    expect(consoleInfoMock).toHaveBeenCalledTimes(1)
    expect(consoleInfoMock).toHaveBeenCalledWith({
      event: 'star_nag_shown',
      app_version: '1.2.3',
      threshold: STAR_NAG_INITIAL_THRESHOLD,
      agents_since_baseline: 35,
      source: 'threshold'
    })
  })

  it('does not replay a stale queued force_show after threshold delivery wins', async () => {
    const window = createWindow()
    browserWindowMock.getAllWindows.mockReturnValue([window])
    const firstStarCheck = createDeferred<boolean | null>()
    checkOrcaStarredMock.mockReturnValueOnce(firstStarCheck.promise).mockResolvedValue(null)
    const { service, emitAgentStarted } = createHarness()

    service.start()
    service.registerIpcHandlers()
    emitAgentStarted(45)
    getIpcHandler('star-nag:forceShow')()

    firstStarCheck.resolve(false)
    await flushAsyncWork()
    getIpcHandler('star-nag:dismiss')()

    emitAgentStarted(114)
    await flushAsyncWork()

    expect(window.webContents.send).toHaveBeenCalledTimes(1)
    expect(consoleInfoMock.mock.calls).toEqual([
      [
        {
          event: 'star_nag_shown',
          app_version: '1.2.3',
          threshold: STAR_NAG_INITIAL_THRESHOLD,
          agents_since_baseline: 35,
          source: 'threshold'
        }
      ],
      [
        {
          event: 'star_nag_dismissed',
          app_version: '1.2.3',
          threshold: STAR_NAG_INITIAL_THRESHOLD,
          agents_since_baseline: 35,
          source: 'threshold',
          next_threshold: STAR_NAG_INITIAL_THRESHOLD * 2
        }
      ]
    ])
  })

  it('does not show after completion wins an in-flight threshold evaluation', async () => {
    const window = createWindow()
    browserWindowMock.getAllWindows.mockReturnValue([window])
    const deferredStarCheck = createDeferred<boolean | null>()
    checkOrcaStarredMock.mockReturnValue(deferredStarCheck.promise)
    const { service, emitAgentStarted, ui } = createHarness()

    service.start()
    service.registerIpcHandlers()
    emitAgentStarted(45)
    getIpcHandler('star-nag:forceShow')()
    getIpcHandler('star-nag:complete')()

    deferredStarCheck.resolve(false)
    await flushAsyncWork()

    expect(ui.starNagCompleted).toBe(true)
    expect(window.webContents.send).not.toHaveBeenCalled()
    expect(consoleInfoMock).not.toHaveBeenCalled()
  })

  it('keeps threshold source when an in-flight star check falls back to the browser', async () => {
    const window = createWindow()
    browserWindowMock.getAllWindows.mockReturnValue([window])
    const deferredStarCheck = createDeferred<boolean | null>()
    checkOrcaStarredMock.mockReturnValue(deferredStarCheck.promise)
    const { service, emitAgentStarted } = createHarness()

    service.start()
    service.registerIpcHandlers()
    emitAgentStarted(45)
    getIpcHandler('star-nag:forceShow')()

    expect(window.webContents.send).not.toHaveBeenCalled()
    expect(consoleInfoMock).not.toHaveBeenCalled()

    deferredStarCheck.resolve(null)
    await flushAsyncWork()

    expect(window.webContents.send).toHaveBeenCalledTimes(1)
    expect(consoleInfoMock).toHaveBeenCalledTimes(1)
    expect(window.webContents.send).toHaveBeenCalledWith('star-nag:show', {
      mode: 'web'
    })
    expect(consoleInfoMock).toHaveBeenCalledWith({
      event: 'star_nag_shown',
      app_version: '1.2.3',
      threshold: STAR_NAG_INITIAL_THRESHOLD,
      agents_since_baseline: 35,
      source: 'threshold'
    })
  })

  it('ignores stray and duplicate dismissals without logging or advancing backoff', () => {
    const window = createWindow()
    browserWindowMock.getAllWindows.mockReturnValue([window])
    const { service, store, ui } = createHarness()

    service.registerIpcHandlers()
    const dismiss = getIpcHandler('star-nag:dismiss')
    dismiss()

    expect(consoleInfoMock).not.toHaveBeenCalled()
    expect(store.updateUI).not.toHaveBeenCalled()
    expect(ui.starNagNextThreshold).toBe(STAR_NAG_INITIAL_THRESHOLD)

    getIpcHandler('star-nag:forceShow')()
    dismiss()
    dismiss()

    const dismissedLogs = consoleInfoMock.mock.calls.filter(
      ([payload]) => (payload as { event?: string }).event === 'star_nag_dismissed'
    )
    expect(dismissedLogs).toHaveLength(1)
    expect(ui.starNagNextThreshold).toBe(STAR_NAG_INITIAL_THRESHOLD * 2)
  })

  it('marks completion without adding duplicate success logging', () => {
    const window = createWindow()
    browserWindowMock.getAllWindows.mockReturnValue([window])
    const { service, ui } = createHarness()

    service.registerIpcHandlers()
    getIpcHandler('star-nag:forceShow')()
    getIpcHandler('star-nag:complete')()

    expect(ui.starNagCompleted).toBe(true)
    expect(consoleInfoMock).toHaveBeenCalledTimes(1)
    expect(consoleInfoMock).toHaveBeenCalledWith({
      event: 'star_nag_shown',
      app_version: '1.2.3',
      threshold: STAR_NAG_INITIAL_THRESHOLD,
      agents_since_baseline: 35,
      source: 'force_show'
    })
  })

  it('emits shown and already_starred_suppressed outcomes with cohort context', async () => {
    const window = createWindow()
    browserWindowMock.getAllWindows.mockReturnValue([window])
    const { service, emitAgentStarted } = createHarness()

    service.start()
    emitAgentStarted(45)
    await flushAsyncWork()

    expect(trackMock).toHaveBeenCalledWith('star_nag_outcome', {
      outcome: 'shown',
      source: 'threshold',
      mode: 'gh',
      threshold: STAR_NAG_INITIAL_THRESHOLD,
      agents_since_baseline: 35,
      agents_since_baseline_bucket: '35-69',
      nth_repo_added: 3
    })

    trackMock.mockClear()
    checkOrcaStarredMock.mockResolvedValue(true)
    const next = createHarness()
    next.service.start()
    next.emitAgentStarted(45)
    await flushAsyncWork()

    expect(trackMock).toHaveBeenCalledWith('star_nag_outcome', {
      outcome: 'already_starred_suppressed',
      source: 'threshold',
      mode: 'gh',
      threshold: STAR_NAG_INITIAL_THRESHOLD,
      agents_since_baseline: 35,
      agents_since_baseline_bucket: '35-69',
      nth_repo_added: 3
    })
  })

  it('emits dismissed, disabled, and opened_web as distinct main-owned outcomes', () => {
    const window = createWindow()
    browserWindowMock.getAllWindows.mockReturnValue([window])
    const dismissed = createHarness()

    dismissed.service.registerIpcHandlers()
    getIpcHandler('star-nag:forceShow')()
    getIpcHandler('star-nag:dismiss')()

    expect(trackMock).toHaveBeenCalledWith('star_nag_outcome', {
      outcome: 'dismissed',
      source: 'force_show',
      mode: 'gh',
      threshold: STAR_NAG_INITIAL_THRESHOLD,
      agents_since_baseline: 35,
      agents_since_baseline_bucket: '35-69',
      nth_repo_added: 3,
      next_threshold: STAR_NAG_INITIAL_THRESHOLD * 2
    })

    trackMock.mockClear()
    ipcMainHandleMock.mockClear()
    const disabled = createHarness()
    disabled.service.registerIpcHandlers()
    getIpcHandler('star-nag:forceShow')()
    getIpcHandler('star-nag:disable')()

    expect(trackMock).toHaveBeenCalledWith(
      'star_nag_outcome',
      expect.objectContaining({ outcome: 'disabled', mode: 'gh' })
    )

    trackMock.mockClear()
    ipcMainHandleMock.mockClear()
    const opened = createHarness()
    opened.service.registerIpcHandlers()
    getIpcHandler('star-nag:forceShow')()
    getIpcHandler('star-nag:openWeb')()

    expect(trackMock).toHaveBeenCalledWith(
      'star_nag_outcome',
      expect.objectContaining({ outcome: 'opened_web', mode: 'web' })
    )
  })

  it('emits direct-star attempted and succeeded outcomes plus app_starred_orca', async () => {
    const window = createWindow()
    browserWindowMock.getAllWindows.mockReturnValue([window])
    const { service, ui } = createHarness()

    service.registerIpcHandlers()
    getIpcHandler('star-nag:forceShow')()
    const ok = await getIpcHandler('star-nag:starOrca')()

    expect(ok).toBe(true)
    expect(ui.starNagCompleted).toBe(true)
    expect(trackMock).toHaveBeenCalledWith(
      'star_nag_outcome',
      expect.objectContaining({ outcome: 'star_attempted', mode: 'gh' })
    )
    expect(trackMock).toHaveBeenCalledWith(
      'star_nag_outcome',
      expect.objectContaining({ outcome: 'star_succeeded', mode: 'gh' })
    )
    expect(trackMock).toHaveBeenCalledWith('app_starred_orca', {
      source: 'star_nag',
      nth_repo_added: 3
    })
  })

  it('uses fresh cohort context for canonical app_starred_orca success telemetry', async () => {
    const window = createWindow()
    browserWindowMock.getAllWindows.mockReturnValue([window])
    getCohortAtEmitMock
      .mockReturnValueOnce({ nth_repo_added: 2 })
      .mockReturnValueOnce({ nth_repo_added: 4 })
    const { service } = createHarness()

    service.registerIpcHandlers()
    getIpcHandler('star-nag:forceShow')()
    await getIpcHandler('star-nag:starOrca')()

    expect(trackMock).toHaveBeenCalledWith(
      'star_nag_outcome',
      expect.objectContaining({ outcome: 'shown', nth_repo_added: 2 })
    )
    expect(trackMock).toHaveBeenCalledWith(
      'star_nag_outcome',
      expect.objectContaining({ outcome: 'star_succeeded', nth_repo_added: 2 })
    )
    expect(trackMock).toHaveBeenCalledWith('app_starred_orca', {
      source: 'star_nag',
      nth_repo_added: 4
    })
  })

  it('records success and completion when direct star resolves after dismissal cleared the visible session', async () => {
    const window = createWindow()
    browserWindowMock.getAllWindows.mockReturnValue([window])
    const deferredStar = createDeferred<boolean>()
    starOrcaMock.mockReturnValue(deferredStar.promise)
    const { service, ui } = createHarness()

    service.registerIpcHandlers()
    getIpcHandler('star-nag:forceShow')()
    const starPromise = getIpcHandler('star-nag:starOrca')()
    getIpcHandler('star-nag:dismiss')()

    deferredStar.resolve(true)
    await expect(starPromise).resolves.toBe(true)

    expect(trackMock).toHaveBeenCalledWith(
      'star_nag_outcome',
      expect.objectContaining({ outcome: 'star_succeeded', mode: 'gh' })
    )
    expect(trackMock).toHaveBeenCalledWith('app_starred_orca', {
      source: 'star_nag',
      nth_repo_added: 3
    })
    expect(ui.starNagCompleted).toBe(true)
  })

  it('clears the in-flight direct-star guard after thrown attempts so the user can retry', async () => {
    const window = createWindow()
    browserWindowMock.getAllWindows.mockReturnValue([window])
    starOrcaMock.mockRejectedValueOnce(new Error('gh failed')).mockResolvedValueOnce(true)
    const { service, ui } = createHarness()

    service.registerIpcHandlers()
    getIpcHandler('star-nag:forceShow')()
    const starFromNag = getIpcHandler('star-nag:starOrca')

    await expect(starFromNag()).rejects.toThrow('gh failed')
    await expect(starFromNag()).resolves.toBe(true)

    expect(starOrcaMock).toHaveBeenCalledTimes(2)
    expect(ui.starNagCompleted).toBe(true)
  })

  it('records failed direct star before web fallback and guards duplicate in-flight attempts', async () => {
    const window = createWindow()
    browserWindowMock.getAllWindows.mockReturnValue([window])
    const deferredStar = createDeferred<boolean>()
    starOrcaMock.mockReturnValue(deferredStar.promise)
    const { service, ui } = createHarness()

    service.registerIpcHandlers()
    getIpcHandler('star-nag:forceShow')()
    const starFromNag = getIpcHandler('star-nag:starOrca')
    const first = starFromNag()
    const second = starFromNag()

    deferredStar.resolve(false)
    await expect(first).resolves.toBe(false)
    await expect(second).resolves.toBe(false)

    const starAttempts = trackMock.mock.calls.filter(
      ([name, payload]) =>
        name === 'star_nag_outcome' &&
        (payload as { outcome?: string }).outcome === 'star_attempted'
    )
    expect(starAttempts).toHaveLength(1)
    expect(trackMock).toHaveBeenCalledWith(
      'star_nag_outcome',
      expect.objectContaining({ outcome: 'star_failed', mode: 'gh' })
    )

    getIpcHandler('star-nag:openWeb')()

    expect(trackMock).toHaveBeenCalledWith(
      'star_nag_outcome',
      expect.objectContaining({ outcome: 'opened_web', mode: 'web' })
    )
    expect(ui.starNagCompleted).toBe(true)
  })
})
