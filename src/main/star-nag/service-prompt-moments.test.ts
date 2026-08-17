import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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

  it('shows agent value moment prompts once per app version after eligibility passes', async () => {
    const window = createWindow()
    browserWindowMock.getAllWindows.mockReturnValue([window])
    const { service, ui } = createHarness()

    service.registerIpcHandlers()
    await expect(getIpcHandler('star-nag:agentValueMoment')()).resolves.toEqual({
      status: 'ready',
      mode: 'gh'
    })
    await getIpcHandler('star-nag:showAgentValueMoment')()
    getIpcHandler('star-nag:dismiss')()
    await expect(getIpcHandler('star-nag:agentValueMoment')()).resolves.toEqual({
      status: 'skipped'
    })

    expect(window.webContents.send).toHaveBeenCalledTimes(1)
    expect(window.webContents.send).toHaveBeenCalledWith('star-nag:show', {
      mode: 'gh',
      surface: 'card'
    })
    expect(ui.starNagAgentValueMomentAppVersion).toBe('1.2.3')
    expect(trackMock).toHaveBeenCalledWith(
      'star_nag_outcome',
      expect.objectContaining({ outcome: 'shown', source: 'agent_value_moment' })
    )
  })

  it('consumes agent value moment for cooldown suppression without showing later in the same version', async () => {
    const window = createWindow()
    browserWindowMock.getAllWindows.mockReturnValue([window])
    const { service, ui } = createHarness({
      starNagDeferredUntil: Date.now() + 3 * 24 * 60 * 60 * 1000
    })

    service.registerIpcHandlers()
    await expect(getIpcHandler('star-nag:agentValueMoment')()).resolves.toEqual({
      status: 'skipped'
    })
    ui.starNagDeferredUntil = null
    await expect(getIpcHandler('star-nag:agentValueMoment')()).resolves.toEqual({
      status: 'skipped'
    })

    expect(window.webContents.send).not.toHaveBeenCalled()
    expect(ui.starNagAgentValueMomentAppVersion).toBe('1.2.3')
  })

  it('does not consume agent value moment when no window can receive the card', async () => {
    const { service, ui } = createHarness()

    service.registerIpcHandlers()
    await expect(getIpcHandler('star-nag:agentValueMoment')()).resolves.toEqual({
      status: 'ready',
      mode: 'gh'
    })
    await getIpcHandler('star-nag:showAgentValueMoment')()

    expect(ui.starNagAgentValueMomentAppVersion).toBeUndefined()

    const window = createWindow()
    browserWindowMock.getAllWindows.mockReturnValue([window])
    await getIpcHandler('star-nag:showAgentValueMoment')()

    expect(window.webContents.send).toHaveBeenCalledWith('star-nag:show', {
      mode: 'gh',
      surface: 'card'
    })
    expect(ui.starNagAgentValueMomentAppVersion).toBe('1.2.3')
  })

  it('shows onboarding completed prompts on the toast surface', async () => {
    const window = createWindow()
    browserWindowMock.getAllWindows.mockReturnValue([window])
    const { service } = createHarness()

    service.registerIpcHandlers()
    await getIpcHandler('star-nag:onboardingCompleted')()

    expect(window.webContents.send).toHaveBeenCalledWith('star-nag:show', {
      mode: 'gh',
      surface: 'toast'
    })
    expect(trackMock).toHaveBeenCalledWith(
      'star_nag_outcome',
      expect.objectContaining({ outcome: 'shown', source: 'onboarding_completed' })
    )
  })

  it('lets onboarding completed supersede an already visible threshold card', async () => {
    const window = createWindow()
    browserWindowMock.getAllWindows.mockReturnValue([window])
    const { service, ui } = createHarness()

    service.registerIpcHandlers()
    getIpcHandler('star-nag:forceShow')()
    await getIpcHandler('star-nag:onboardingCompleted')()

    expect(window.webContents.send).toHaveBeenNthCalledWith(1, 'star-nag:show', {
      mode: 'gh',
      surface: 'card'
    })
    expect(window.webContents.send).toHaveBeenNthCalledWith(2, 'star-nag:hide')
    expect(window.webContents.send).toHaveBeenNthCalledWith(3, 'star-nag:show', {
      mode: 'gh',
      surface: 'toast'
    })
    expect(trackMock).toHaveBeenCalledWith(
      'star_nag_outcome',
      expect.objectContaining({ outcome: 'shown', source: 'onboarding_completed' })
    )
    expect(ui.starNagCompleted).toBeUndefined()
  })

  it('hides a superseded visible card when onboarding completion detects an existing star', async () => {
    const window = createWindow()
    browserWindowMock.getAllWindows.mockReturnValue([window])
    checkOrcaStarredMock.mockResolvedValueOnce(true)
    const { service, ui } = createHarness()

    service.registerIpcHandlers()
    getIpcHandler('star-nag:forceShow')()
    await getIpcHandler('star-nag:onboardingCompleted')()

    expect(window.webContents.send).toHaveBeenNthCalledWith(1, 'star-nag:show', {
      mode: 'gh',
      surface: 'card'
    })
    expect(window.webContents.send).toHaveBeenNthCalledWith(2, 'star-nag:hide')
    expect(window.webContents.send).toHaveBeenCalledTimes(2)
    expect(ui.starNagCompleted).toBe(true)
  })

  it('queues onboarding completed while a threshold star check is in flight', async () => {
    const window = createWindow()
    browserWindowMock.getAllWindows.mockReturnValue([window])
    const deferredStarCheck = createDeferred<boolean | null>()
    checkOrcaStarredMock.mockReturnValueOnce(deferredStarCheck.promise).mockResolvedValueOnce(null)
    const { service, emitAgentStarted, ui } = createHarness()

    service.start()
    service.registerIpcHandlers()
    emitAgentStarted(45)
    await getIpcHandler('star-nag:onboardingCompleted')()

    expect(window.webContents.send).not.toHaveBeenCalled()

    deferredStarCheck.resolve(false)
    await flushAsyncWork()

    expect(window.webContents.send).toHaveBeenNthCalledWith(1, 'star-nag:show', {
      mode: 'gh',
      surface: 'card'
    })
    expect(window.webContents.send).toHaveBeenNthCalledWith(2, 'star-nag:hide')
    expect(window.webContents.send).toHaveBeenNthCalledWith(3, 'star-nag:show', {
      mode: 'web',
      surface: 'toast'
    })
    expect(trackMock).toHaveBeenCalledWith(
      'star_nag_outcome',
      expect.objectContaining({ outcome: 'shown', source: 'onboarding_completed', mode: 'web' })
    )
    expect(ui.starNagCompleted).toBeUndefined()
  })

  it('queues onboarding completed while an agent value moment star check is in flight', async () => {
    const window = createWindow()
    browserWindowMock.getAllWindows.mockReturnValue([window])
    const deferredStarCheck = createDeferred<boolean | null>()
    checkOrcaStarredMock.mockReturnValueOnce(deferredStarCheck.promise).mockResolvedValueOnce(null)
    const { service, ui } = createHarness()

    service.registerIpcHandlers()
    const agentValueMoment = getIpcHandler('star-nag:agentValueMoment')()
    await getIpcHandler('star-nag:onboardingCompleted')()

    deferredStarCheck.resolve(false)
    await expect(agentValueMoment).resolves.toEqual({ status: 'ready', mode: 'gh' })
    await flushAsyncWork()

    expect(window.webContents.send).toHaveBeenCalledWith('star-nag:show', {
      mode: 'web',
      surface: 'toast'
    })
    expect(trackMock).toHaveBeenCalledWith(
      'star_nag_outcome',
      expect.objectContaining({ outcome: 'shown', source: 'onboarding_completed', mode: 'web' })
    )
    expect(ui.starNagCompleted).toBeUndefined()
  })
})
