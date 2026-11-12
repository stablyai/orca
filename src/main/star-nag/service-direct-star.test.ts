import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createDeferred,
  createHarness,
  createIpcHandlerLookup,
  createWindow,
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

vi.mock('../github/client/fetch/orca-star', () => ({
  checkOrcaStarred: mocks.checkOrcaStarredMock,
  starOrca: mocks.starOrcaMock
}))

vi.mock('../telemetry/client', () => ({
  track: mocks.trackMock
}))

vi.mock('../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: mocks.getCohortAtEmitMock
}))

const { browserWindowMock, starOrcaMock, trackMock } = mocks
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
      expect.objectContaining({ outcome: 'direct_star_succeeded', mode: 'gh' })
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
})
