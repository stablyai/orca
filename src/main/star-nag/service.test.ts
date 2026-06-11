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

const { appMock, browserWindowMock, checkOrcaStarredMock, ipcMainHandleMock } = vi.hoisted(() => ({
  appMock: {
    getVersion: vi.fn(() => '1.2.3')
  },
  browserWindowMock: {
    getAllWindows: vi.fn<() => TestWindow[]>(() => [])
  },
  checkOrcaStarredMock: vi.fn(),
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
  checkOrcaStarred: checkOrcaStarredMock
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
    expect(window.webContents.send).toHaveBeenCalledWith('star-nag:show', { mode: 'gh' })
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

    expect(window.webContents.send).toHaveBeenCalledWith('star-nag:show', { mode: 'web' })
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

    const window = createWindow()
    browserWindowMock.getAllWindows.mockReturnValue([window])
    emitAgentStarted(46)
    await flushAsyncWork()

    expect(window.webContents.send).toHaveBeenCalledWith('star-nag:show', { mode: 'gh' })
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

    expect(window.webContents.send).toHaveBeenCalledWith('star-nag:show', { mode: 'gh' })
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
    expect(window.webContents.send).toHaveBeenCalledWith('star-nag:show', { mode: 'web' })
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
})
