import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { STAR_NAG_INITIAL_THRESHOLD } from '../../shared/constants'
import {
  createDeferred,
  createHarness,
  createIpcHandlerLookup,
  createWindow,
  flushAsyncWork,
  resetStarNagMocks,
  type TestWindow
} from './service-test-harness'

const mocks = vi.hoisted(() => ({
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
  app: mocks.appMock,
  BrowserWindow: mocks.browserWindowMock,
  ipcMain: {
    handle: mocks.ipcMainHandleMock
  }
}))

vi.mock('../github/client', () => ({
  checkOrcaStarred: mocks.checkOrcaStarredMock,
  starOrca: mocks.starOrcaMock
}))

vi.mock('../telemetry/client', () => ({
  track: mocks.trackMock
}))

vi.mock('../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: mocks.getCohortAtEmitMock
}))

const { browserWindowMock, checkOrcaStarredMock } = mocks
const getIpcHandler = createIpcHandlerLookup(mocks.ipcMainHandleMock)

describe('StarNagService', () => {
  let consoleInfoMock: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    resetStarNagMocks(mocks)
    consoleInfoMock = vi.spyOn(console, 'info').mockImplementation(() => undefined)
  })

  afterEach(() => {
    consoleInfoMock.mockRestore()
  })

  it('allows force_show to bypass the persisted cooldown', () => {
    const window = createWindow()
    browserWindowMock.getAllWindows.mockReturnValue([window])
    const { service } = createHarness({
      starNagDeferredUntil: Date.now() + 3 * 24 * 60 * 60 * 1000
    })

    service.registerIpcHandlers()
    getIpcHandler('star-nag:forceShow')()

    expect(window.webContents.send).toHaveBeenCalledWith('star-nag:show', {
      mode: 'gh',
      surface: 'card'
    })
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
      mode: 'gh',
      surface: 'card'
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
      mode: 'web',
      surface: 'card'
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
})
