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

const { browserWindowMock, checkOrcaStarredMock, ipcMainHandleMock, trackMock } = mocks
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

  it('emits dismissed, disabled, and opened_repo as distinct main-owned outcomes', () => {
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
      next_threshold: STAR_NAG_INITIAL_THRESHOLD * 2,
      cooldown_days: 3
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
      expect.objectContaining({ outcome: 'opened_repo', mode: 'web' })
    )
    expect(opened.ui.starNagCompleted).toBeUndefined()
    expect(opened.ui.starNagDeferredUntil).toBeGreaterThan(Date.now())
    expect(opened.ui.starNagNextThreshold).toBe(STAR_NAG_INITIAL_THRESHOLD * 2)
  })

  it('emits opened_repo at most once for one prompt session', () => {
    const window = createWindow()
    browserWindowMock.getAllWindows.mockReturnValue([window])
    const { service } = createHarness()

    service.registerIpcHandlers()
    getIpcHandler('star-nag:forceShow')()
    getIpcHandler('star-nag:openWeb')()
    getIpcHandler('star-nag:openWeb')()

    const openedRepoOutcomes = trackMock.mock.calls.filter(
      ([name, payload]) =>
        name === 'star_nag_outcome' && (payload as { outcome?: string }).outcome === 'opened_repo'
    )
    expect(openedRepoOutcomes).toHaveLength(1)
  })

  it('emits later cooldown outcome without completing', () => {
    const window = createWindow()
    browserWindowMock.getAllWindows.mockReturnValue([window])
    const later = createHarness()

    later.service.registerIpcHandlers()
    getIpcHandler('star-nag:forceShow')()
    getIpcHandler('star-nag:later')()

    expect(trackMock).toHaveBeenCalledWith(
      'star_nag_outcome',
      expect.objectContaining({ outcome: 'later', cooldown_days: 3 })
    )
    expect(consoleInfoMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ event: 'star_nag_later' })
    )
    expect(later.ui.starNagCompleted).toBeUndefined()
    expect(later.ui.starNagDeferredUntil).toBeGreaterThan(Date.now())
  })

  it('does not emit confirmed star telemetry for web fallback handoff', async () => {
    const window = createWindow()
    browserWindowMock.getAllWindows.mockReturnValue([window])
    checkOrcaStarredMock.mockResolvedValue(null)
    const { service, ui } = createHarness()

    service.registerIpcHandlers()
    await getIpcHandler('star-nag:onboardingCompleted')()
    getIpcHandler('star-nag:openWeb')()

    expect(trackMock).toHaveBeenCalledWith(
      'star_nag_outcome',
      expect.objectContaining({ outcome: 'opened_repo', source: 'onboarding_completed' })
    )
    expect(trackMock).not.toHaveBeenCalledWith(
      'app_starred_orca',
      expect.objectContaining({ source: 'onboarding_completed' })
    )
    expect(ui.starNagCompleted).toBeUndefined()
    expect(ui.starNagDeferredUntil).toBeGreaterThan(Date.now())
  })
})
