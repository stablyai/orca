import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { STAR_NAG_INITIAL_THRESHOLD } from '../../shared/constants'
import {
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

const { browserWindowMock, checkOrcaStarredMock, trackMock } = mocks
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
      mode: 'gh',
      surface: 'card'
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
      mode: 'web',
      surface: 'card'
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
      mode: 'gh',
      surface: 'card'
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
    expect(ui.starNagDeferredUntil).toBeGreaterThan(Date.now())
  })

  it('does not show threshold prompts while the persisted cooldown is active', async () => {
    const window = createWindow()
    browserWindowMock.getAllWindows.mockReturnValue([window])
    const { service, emitAgentStarted } = createHarness({
      starNagDeferredUntil: Date.now() + 3 * 24 * 60 * 60 * 1000
    })

    service.start()
    emitAgentStarted(45)
    await flushAsyncWork()

    expect(window.webContents.send).not.toHaveBeenCalled()
    expect(trackMock).not.toHaveBeenCalled()
  })
})
