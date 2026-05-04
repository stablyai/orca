/* eslint-disable max-lines */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  appMock,
  browserWindowMock,
  nativeUpdaterMock,
  autoUpdaterMock,
  isMock,
  killAllPtyMock,
  powerMonitorOnMock
} = vi.hoisted(() => {
  const appEventHandlers = new Map<string, ((...args: unknown[]) => void)[]>()
  const eventHandlers = new Map<string, ((...args: unknown[]) => void)[]>()

  const appOn = vi.fn((event: string, handler: (...args: unknown[]) => void) => {
    const handlers = appEventHandlers.get(event) ?? []
    handlers.push(handler)
    appEventHandlers.set(event, handlers)
    return appMock
  })

  const appEmit = (event: string, ...args: unknown[]) => {
    for (const handler of appEventHandlers.get(event) ?? []) {
      handler(...args)
    }
  }

  const on = vi.fn((event: string, handler: (...args: unknown[]) => void) => {
    const handlers = eventHandlers.get(event) ?? []
    handlers.push(handler)
    eventHandlers.set(event, handlers)
    return autoUpdaterMock
  })

  const emit = (event: string, ...args: unknown[]) => {
    for (const handler of eventHandlers.get(event) ?? []) {
      handler(...args)
    }
  }

  const reset = () => {
    appEventHandlers.clear()
    appOn.mockClear()
    eventHandlers.clear()
    on.mockClear()
    autoUpdaterMock.checkForUpdates.mockReset().mockResolvedValue(null)
    autoUpdaterMock.downloadUpdate.mockReset()
    autoUpdaterMock.quitAndInstall.mockReset()
    autoUpdaterMock.setFeedURL.mockClear()
    autoUpdaterMock.allowPrerelease = false
    delete (autoUpdaterMock as Record<string, unknown>).verifyUpdateCodeSignature
  }

  const autoUpdaterMock = {
    autoDownload: false,
    autoInstallOnAppQuit: false,
    allowPrerelease: false,
    on,
    checkForUpdates: vi.fn(),
    downloadUpdate: vi.fn(),
    quitAndInstall: vi.fn(),
    setFeedURL: vi.fn(),
    emit,
    reset
  }

  return {
    appMock: {
      isPackaged: true,
      getVersion: vi.fn(() => '1.0.51'),
      on: appOn,
      emit: appEmit,
      quit: vi.fn()
    },
    browserWindowMock: {
      getAllWindows: vi.fn(() => [])
    },
    nativeUpdaterMock: {
      on: vi.fn()
    },
    autoUpdaterMock,
    isMock: { dev: false },
    killAllPtyMock: vi.fn(),
    powerMonitorOnMock: vi.fn()
  }
})

vi.mock('electron', () => ({
  app: appMock,
  BrowserWindow: browserWindowMock,
  autoUpdater: nativeUpdaterMock,
  powerMonitor: { on: powerMonitorOnMock },
  net: { fetch: vi.fn() }
}))

vi.mock('electron-updater', () => ({
  autoUpdater: autoUpdaterMock
}))

vi.mock('@electron-toolkit/utils', () => ({
  is: isMock
}))

vi.mock('./ipc/pty', () => ({
  killAllPty: killAllPtyMock
}))

vi.mock('./updater-changelog', () => ({
  fetchChangelog: vi.fn().mockResolvedValue(null)
}))

const { fetchNudgeMock, shouldApplyNudgeMock } = vi.hoisted(() => ({
  fetchNudgeMock: vi.fn(),
  shouldApplyNudgeMock: vi.fn()
}))

vi.mock('./updater-nudge', () => ({
  fetchNudge: fetchNudgeMock,
  shouldApplyNudge: shouldApplyNudgeMock
}))

const { fetchNewerReleaseTagMock } = vi.hoisted(() => ({
  fetchNewerReleaseTagMock: vi.fn()
}))

vi.mock('./updater-prerelease-feed', () => ({
  fetchNewerReleaseTag: fetchNewerReleaseTagMock,
  getReleaseDownloadUrl: (tag: string) =>
    `https://github.com/stablyai/orca/releases/download/${tag}`
}))

describe('updater', () => {
  beforeEach(() => {
    vi.resetModules()
    autoUpdaterMock.reset()
    nativeUpdaterMock.on.mockReset()
    browserWindowMock.getAllWindows.mockReset()
    browserWindowMock.getAllWindows.mockReturnValue([])
    appMock.getVersion.mockReset()
    appMock.getVersion.mockReturnValue('1.0.51')
    appMock.quit.mockReset()
    appMock.isPackaged = true
    isMock.dev = false
    killAllPtyMock.mockReset()
    powerMonitorOnMock.mockReset()
    fetchNudgeMock.mockReset().mockResolvedValue(null)
    shouldApplyNudgeMock.mockReset().mockReturnValue(false)
    fetchNewerReleaseTagMock.mockReset().mockResolvedValue(null)
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('deduplicates identical check errors from the event and rejected promise', async () => {
    autoUpdaterMock.checkForUpdates.mockResolvedValueOnce(undefined).mockImplementationOnce(() => {
      autoUpdaterMock.emit('checking-for-update')
      queueMicrotask(() => {
        autoUpdaterMock.emit('error', new Error('boom'))
      })
      return Promise.reject(new Error('boom'))
    })

    const sendMock = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }

    const { setupAutoUpdater, checkForUpdatesFromMenu } = await import('./updater')

    setupAutoUpdater(mainWindow as never)
    checkForUpdatesFromMenu()
    await vi.waitFor(() => {
      const statuses = sendMock.mock.calls
        .filter(([channel]) => channel === 'updater:status')
        .map(([, status]) => status)
      expect(statuses).toContainEqual({ state: 'error', message: 'boom', userInitiated: true })
    })

    const errorStatuses = sendMock.mock.calls
      .filter(([channel]) => channel === 'updater:status')
      .map(([, status]) => status)
      .filter((status) => typeof status === 'object' && status !== null && status.state === 'error')

    expect(errorStatuses).toEqual([{ state: 'error', message: 'boom', userInitiated: true }])
  })

  it('surfaces net::ERR_FAILED to user-initiated checks with a friendly message', async () => {
    autoUpdaterMock.checkForUpdates.mockResolvedValueOnce(undefined).mockImplementationOnce(() => {
      autoUpdaterMock.emit('checking-for-update')
      queueMicrotask(() => {
        autoUpdaterMock.emit('error', new Error('net::ERR_FAILED'))
      })
      return Promise.reject(new Error('net::ERR_FAILED'))
    })

    const sendMock = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }

    const { setupAutoUpdater, checkForUpdatesFromMenu } = await import('./updater')

    setupAutoUpdater(mainWindow as never)
    checkForUpdatesFromMenu()
    await vi.waitFor(() => {
      const statuses = sendMock.mock.calls
        .filter(([channel]) => channel === 'updater:status')
        .map(([, status]) => status)
      expect(statuses).toContainEqual(
        expect.objectContaining({
          state: 'error',
          userInitiated: true,
          message: expect.stringContaining('GitHub may be temporarily unavailable')
        })
      )
    })

    const statuses = sendMock.mock.calls
      .filter(([channel]) => channel === 'updater:status')
      .map(([, status]) => status)

    expect(statuses).toContainEqual({ state: 'checking', userInitiated: true })
    // Why: the raw electron-updater message is replaced with a user-friendly
    // one so we never surface "net::ERR_FAILED" directly to the UI.
    expect(statuses).not.toContainEqual(
      expect.objectContaining({ state: 'error', message: 'net::ERR_FAILED' })
    )
  })

  it('opts into the RC channel when checkForUpdatesFromMenu is called with includePrerelease', async () => {
    autoUpdaterMock.checkForUpdates.mockResolvedValue(undefined)
    const mainWindow = { webContents: { send: vi.fn() } }

    const { setupAutoUpdater, checkForUpdatesFromMenu } = await import('./updater')

    // Why: pass a recent timestamp so the startup background check is
    // deferred. We want to observe the state of the updater *before* any
    // RC-mode call, not race with the startup check.
    setupAutoUpdater(mainWindow as never, { getLastUpdateCheckAt: () => Date.now() })
    const setupFeedUrlCalls = autoUpdaterMock.setFeedURL.mock.calls.length
    expect(autoUpdaterMock.allowPrerelease).not.toBe(true)

    checkForUpdatesFromMenu({ includePrerelease: true })

    expect(autoUpdaterMock.allowPrerelease).toBe(true)
    const newCalls = autoUpdaterMock.setFeedURL.mock.calls.slice(setupFeedUrlCalls)
    expect(newCalls).toEqual([[{ provider: 'github', owner: 'stablyai', repo: 'orca' }]])
    expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)

    // Second RC-mode invocation should not re-set the feed URL.
    checkForUpdatesFromMenu({ includePrerelease: true })
    expect(autoUpdaterMock.setFeedURL.mock.calls.length).toBe(setupFeedUrlCalls + 1)
  })

  it('leaves the feed URL alone for a normal user-initiated check', async () => {
    autoUpdaterMock.checkForUpdates.mockResolvedValue(undefined)
    const mainWindow = { webContents: { send: vi.fn() } }

    const { setupAutoUpdater, checkForUpdatesFromMenu } = await import('./updater')

    setupAutoUpdater(mainWindow as never, { getLastUpdateCheckAt: () => Date.now() })
    const initialFeedUrlCalls = autoUpdaterMock.setFeedURL.mock.calls.length

    checkForUpdatesFromMenu()
    checkForUpdatesFromMenu({ includePrerelease: false })

    expect(autoUpdaterMock.setFeedURL.mock.calls.length).toBe(initialFeedUrlCalls)
    expect(autoUpdaterMock.allowPrerelease).not.toBe(true)
  })

  it('defers quitAndInstall through the shared main-process entrypoint', async () => {
    vi.useFakeTimers()

    const mainWindow = { webContents: { send: vi.fn() } }
    const { setupAutoUpdater, quitAndInstall } = await import('./updater')

    setupAutoUpdater(mainWindow as never)
    quitAndInstall()

    expect(autoUpdaterMock.quitAndInstall).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(99)
    expect(autoUpdaterMock.quitAndInstall).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)
    expect(autoUpdaterMock.quitAndInstall).toHaveBeenCalledTimes(1)
    expect(autoUpdaterMock.quitAndInstall).toHaveBeenCalledWith(false, true)
  })

  it('ignores duplicate quitAndInstall requests while the shared delay is pending', async () => {
    vi.useFakeTimers()

    const mainWindow = { webContents: { send: vi.fn() } }
    const { setupAutoUpdater, quitAndInstall } = await import('./updater')

    setupAutoUpdater(mainWindow as never)
    quitAndInstall()
    quitAndInstall()

    await vi.advanceTimersByTimeAsync(100)

    expect(autoUpdaterMock.quitAndInstall).toHaveBeenCalledTimes(1)
  })

  it('runs a startup check immediately when the last background check is stale', async () => {
    const mainWindow = { webContents: { send: vi.fn() } }
    const setLastUpdateCheckAt = vi.fn()

    const { setupAutoUpdater } = await import('./updater')

    setupAutoUpdater(mainWindow as never, {
      getLastUpdateCheckAt: () => Date.now() - 25 * 60 * 60 * 1000,
      setLastUpdateCheckAt
    })

    expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)
    expect(setLastUpdateCheckAt).not.toHaveBeenCalled()
  })

  it('starts nudge polling only after updater initialization is complete', async () => {
    const mainWindow = { webContents: { send: vi.fn() } }
    fetchNudgeMock.mockResolvedValue({ id: 'campaign-1', minVersion: '1.0.0' })
    shouldApplyNudgeMock.mockReturnValue(true)

    const { setupAutoUpdater } = await import('./updater')

    setupAutoUpdater(mainWindow as never)

    expect(autoUpdaterMock.setFeedURL).toHaveBeenCalledTimes(1)
    expect(autoUpdaterMock.on).toHaveBeenCalled()
    expect(fetchNudgeMock).toHaveBeenCalledTimes(1)
    expect(autoUpdaterMock.setFeedURL.mock.invocationCallOrder[0]).toBeLessThan(
      fetchNudgeMock.mock.invocationCallOrder[0]
    )
    expect(autoUpdaterMock.on.mock.invocationCallOrder[0]).toBeLessThan(
      fetchNudgeMock.mock.invocationCallOrder[0]
    )
  })

  it('waits until the remaining interval before the next background check', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-03T12:00:00Z'))

    const mainWindow = { webContents: { send: vi.fn() } }
    const setLastUpdateCheckAt = vi.fn()

    const { setupAutoUpdater } = await import('./updater')

    setupAutoUpdater(mainWindow as never, {
      getLastUpdateCheckAt: () => Date.now() - 23 * 60 * 60 * 1000,
      setLastUpdateCheckAt
    })

    expect(autoUpdaterMock.checkForUpdates).not.toHaveBeenCalled()

    vi.advanceTimersByTime(59 * 60 * 1000)
    expect(autoUpdaterMock.checkForUpdates).not.toHaveBeenCalled()

    vi.advanceTimersByTime(60 * 1000)
    expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)
    expect(setLastUpdateCheckAt).not.toHaveBeenCalled()
  })

  it('deduplicates rapid focus-triggered daily checks before checking status arrives', async () => {
    let lastUpdateCheckAt = Date.now()
    const mainWindow = { webContents: { send: vi.fn() } }

    autoUpdaterMock.checkForUpdates.mockImplementation(() => new Promise(() => {}))

    const { setupAutoUpdater } = await import('./updater')

    setupAutoUpdater(mainWindow as never, {
      getLastUpdateCheckAt: () => lastUpdateCheckAt
    })

    lastUpdateCheckAt = Date.now() - 25 * 60 * 60 * 1000
    appMock.emit('browser-window-focus')
    appMock.emit('browser-window-focus')

    expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)
  })

  it('does not persist lastUpdateCheckAt when a focus-triggered check fails benignly', async () => {
    let lastUpdateCheckAt = Date.now()
    const setLastUpdateCheckAt = vi.fn()
    const sendMock = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }

    autoUpdaterMock.checkForUpdates.mockImplementation(() => {
      autoUpdaterMock.emit('checking-for-update')
      queueMicrotask(() => {
        autoUpdaterMock.emit('error', new Error('net::ERR_FAILED'))
      })
      return Promise.reject(new Error('net::ERR_FAILED'))
    })

    const { setupAutoUpdater } = await import('./updater')

    setupAutoUpdater(mainWindow as never, {
      getLastUpdateCheckAt: () => lastUpdateCheckAt,
      setLastUpdateCheckAt
    })

    lastUpdateCheckAt = Date.now() - 25 * 60 * 60 * 1000
    appMock.emit('browser-window-focus')

    await vi.waitFor(() => {
      const statuses = sendMock.mock.calls
        .filter(([channel]) => channel === 'updater:status')
        .map(([, status]) => status)
      expect(statuses).toContainEqual({ state: 'idle' })
    })

    expect(setLastUpdateCheckAt).not.toHaveBeenCalled()
  })

  it('retries background checks sooner after a failed automatic check', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-03T12:00:00Z'))

    autoUpdaterMock.checkForUpdates.mockImplementation(() => {
      autoUpdaterMock.emit('checking-for-update')
      queueMicrotask(() => {
        autoUpdaterMock.emit('error', new Error('boom'))
      })
      return Promise.reject(new Error('boom'))
    })

    const sendMock = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }

    const { setupAutoUpdater } = await import('./updater')

    setupAutoUpdater(mainWindow as never, {
      getLastUpdateCheckAt: () => null,
      setLastUpdateCheckAt: vi.fn()
    })

    await vi.runAllTicks()
    expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(59 * 60 * 1000)
    expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(60 * 1000)
    expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(2)
  })

  it('reschedules the next automatic check 24 hours after finding an available update', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-03T12:00:00Z'))

    autoUpdaterMock.checkForUpdates.mockImplementation(() => {
      autoUpdaterMock.emit('checking-for-update')
      queueMicrotask(() => {
        autoUpdaterMock.emit('update-available', { version: '1.0.61' })
      })
      return Promise.resolve(undefined)
    })

    const sendMock = vi.fn()
    const setLastUpdateCheckAt = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }

    const { setupAutoUpdater } = await import('./updater')

    setupAutoUpdater(mainWindow as never, {
      getLastUpdateCheckAt: () => null,
      setLastUpdateCheckAt
    })

    await vi.runAllTicks()
    await vi.advanceTimersByTimeAsync(0)

    expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)
    expect(setLastUpdateCheckAt).toHaveBeenCalledTimes(1)
    expect(sendMock).toHaveBeenCalledWith('updater:status', {
      state: 'available',
      version: '1.0.61',
      changelog: null
    })

    vi.advanceTimersByTime(23 * 60 * 60 * 1000 + 59 * 60 * 1000)
    expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(60 * 1000)
    expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(2)
  })

  it('does not leak a nudge marker into a later ordinary update cycle', async () => {
    const sendMock = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }

    fetchNudgeMock.mockResolvedValue({ id: 'campaign-1', minVersion: '1.0.0' })
    shouldApplyNudgeMock.mockReturnValue(true)
    autoUpdaterMock.checkForUpdates.mockImplementation(() => {
      autoUpdaterMock.emit('checking-for-update')
      return Promise.resolve(undefined)
    })

    const { setupAutoUpdater, checkForUpdatesFromMenu } = await import('./updater')

    // Why: pass a recent timestamp so the normal startup check is deferred,
    // letting the nudge check run without hitting the 'checking' guard.
    setupAutoUpdater(mainWindow as never, {
      getLastUpdateCheckAt: () => Date.now()
    })
    await new Promise((resolve) => setTimeout(resolve, 0))

    autoUpdaterMock.emit('update-available', { version: '1.0.61' })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(sendMock).toHaveBeenCalledWith('updater:status', {
      state: 'available',
      version: '1.0.61',
      changelog: null,
      activeNudgeId: 'campaign-1'
    })

    sendMock.mockClear()
    checkForUpdatesFromMenu()

    const statusCalls = sendMock.mock.calls
      .filter(([channel]) => channel === 'updater:status')
      .map(([, status]) => status)

    expect(statusCalls).toContainEqual({ state: 'checking', userInitiated: true })

    autoUpdaterMock.emit('update-available', { version: '1.0.62' })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(sendMock).toHaveBeenCalledWith('updater:status', {
      state: 'available',
      version: '1.0.62',
      changelog: null
    })
    expect(sendMock).not.toHaveBeenCalledWith(
      'updater:status',
      expect.objectContaining({ version: '1.0.62', activeNudgeId: 'campaign-1' })
    )
  })

  it('preserves the pending nudge marker across a later background check', async () => {
    const sendMock = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }

    autoUpdaterMock.checkForUpdates.mockImplementation(() => {
      autoUpdaterMock.emit('checking-for-update')
      return Promise.resolve(undefined)
    })

    const { setupAutoUpdater } = await import('./updater')

    setupAutoUpdater(mainWindow as never, {
      getLastUpdateCheckAt: () => null,
      getPendingUpdateNudgeId: () => 'campaign-1',
      getDismissedUpdateNudgeId: () => null
    })

    autoUpdaterMock.emit('update-available', { version: '1.0.61' })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(sendMock).toHaveBeenCalledWith('updater:status', {
      state: 'available',
      version: '1.0.61',
      changelog: null,
      activeNudgeId: 'campaign-1'
    })
  })

  it('does not trigger a nudge check while an updater check is already in progress', async () => {
    const sendMock = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }

    fetchNudgeMock.mockResolvedValue({ id: 'campaign-1', minVersion: '1.0.0' })
    shouldApplyNudgeMock.mockReturnValue(true)
    autoUpdaterMock.checkForUpdates.mockImplementation(() => {
      autoUpdaterMock.emit('checking-for-update')
      // Stay in 'checking' state — don't resolve
      return new Promise(() => {})
    })

    const { setupAutoUpdater } = await import('./updater')

    setupAutoUpdater(mainWindow as never, {
      getLastUpdateCheckAt: () => null,
      setLastUpdateCheckAt: vi.fn()
    })

    // Wait for the startup nudge check to run
    await new Promise((resolve) => setTimeout(resolve, 0))

    // The normal startup check is in progress (status is 'checking').
    // The nudge fetch completed but the guard should have prevented
    // calling runBackgroundUpdateCheck because currentStatus is 'checking'.
    // Only the startup check should have called checkForUpdates.
    expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)
  })

  it('respects the activation/resume cooldown for nudge checks', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-12T12:00:00Z'))

    const sendMock = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }

    fetchNudgeMock.mockResolvedValue({ id: 'campaign-1', minVersion: '1.0.0' })
    shouldApplyNudgeMock.mockReturnValue(true)
    autoUpdaterMock.checkForUpdates.mockResolvedValue(undefined)

    const { setupAutoUpdater } = await import('./updater')

    setupAutoUpdater(mainWindow as never)

    // Wait for the startup nudge check to complete
    await vi.advanceTimersByTimeAsync(0)

    // The startup check already set lastNudgeCheckAt. Triggering
    // browser-window-focus should be blocked by the 5-minute cooldown.
    fetchNudgeMock.mockClear()
    appMock.emit('browser-window-focus')
    await vi.advanceTimersByTimeAsync(0)

    // fetchNudge should NOT have been called again — cooldown blocks it
    expect(fetchNudgeMock).not.toHaveBeenCalled()

    // Advance past the cooldown
    vi.advanceTimersByTime(5 * 60 * 1000 + 1)
    appMock.emit('browser-window-focus')
    await vi.advanceTimersByTimeAsync(0)

    expect(fetchNudgeMock).toHaveBeenCalledTimes(1)
  })

  it('clears pending nudge campaign when the follow-up check ends in not-available', async () => {
    const sendMock = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }
    const setPendingUpdateNudgeId = vi.fn()
    const setDismissedUpdateNudgeId = vi.fn()

    fetchNudgeMock.mockResolvedValue({ id: 'campaign-1', minVersion: '1.0.0' })
    shouldApplyNudgeMock.mockReturnValue(true)
    autoUpdaterMock.checkForUpdates.mockImplementation(() => {
      autoUpdaterMock.emit('checking-for-update')
      return Promise.resolve(undefined)
    })

    const { setupAutoUpdater } = await import('./updater')

    setupAutoUpdater(mainWindow as never, {
      getLastUpdateCheckAt: () => Date.now(),
      setPendingUpdateNudgeId,
      getPendingUpdateNudgeId: () => null,
      getDismissedUpdateNudgeId: () => null,
      setDismissedUpdateNudgeId
    })

    await new Promise((resolve) => setTimeout(resolve, 0))

    // Nudge was applied — pending id was set
    expect(setPendingUpdateNudgeId).toHaveBeenCalledWith('campaign-1')

    // Now simulate the updater finding no update
    autoUpdaterMock.emit('update-not-available')

    // Pending should be cleared and campaign should be auto-dismissed
    // so it doesn't re-fire on the next poll cycle
    expect(setPendingUpdateNudgeId).toHaveBeenCalledWith(null)
    expect(setDismissedUpdateNudgeId).toHaveBeenCalledWith('campaign-1')
  })

  it('auto-dismisses nudge campaign when the follow-up check errors out', async () => {
    const sendMock = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }
    const setPendingUpdateNudgeId = vi.fn()
    const setDismissedUpdateNudgeId = vi.fn()

    fetchNudgeMock.mockResolvedValue({ id: 'campaign-1', minVersion: '1.0.0' })
    shouldApplyNudgeMock.mockReturnValue(true)
    autoUpdaterMock.checkForUpdates.mockImplementation(() => {
      autoUpdaterMock.emit('checking-for-update')
      return Promise.resolve(undefined)
    })

    const { setupAutoUpdater } = await import('./updater')

    setupAutoUpdater(mainWindow as never, {
      getLastUpdateCheckAt: () => Date.now(),
      setPendingUpdateNudgeId,
      getPendingUpdateNudgeId: () => null,
      getDismissedUpdateNudgeId: () => null,
      setDismissedUpdateNudgeId
    })

    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(setPendingUpdateNudgeId).toHaveBeenCalledWith('campaign-1')

    // Simulate an error during the nudge-triggered check
    autoUpdaterMock.emit('error', new Error('network timeout'))

    // Campaign should be auto-dismissed to prevent re-fire loop
    expect(setDismissedUpdateNudgeId).toHaveBeenCalledWith('campaign-1')
    expect(setPendingUpdateNudgeId).toHaveBeenCalledWith(null)
  })

  it('moves pending nudge to dismissed when dismissNudge is called', async () => {
    const sendMock = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }
    const setPendingUpdateNudgeId = vi.fn()
    const setDismissedUpdateNudgeId = vi.fn()

    fetchNudgeMock.mockResolvedValue({ id: 'campaign-1', minVersion: '1.0.0' })
    shouldApplyNudgeMock.mockReturnValue(true)
    autoUpdaterMock.checkForUpdates.mockImplementation(() => {
      autoUpdaterMock.emit('checking-for-update')
      return Promise.resolve(undefined)
    })

    const { setupAutoUpdater, dismissNudge } = await import('./updater')

    setupAutoUpdater(mainWindow as never, {
      getLastUpdateCheckAt: () => Date.now(),
      setPendingUpdateNudgeId,
      getPendingUpdateNudgeId: () => 'campaign-1',
      getDismissedUpdateNudgeId: () => null,
      setDismissedUpdateNudgeId
    })

    await new Promise((resolve) => setTimeout(resolve, 0))

    // Simulate update found, then user dismisses
    autoUpdaterMock.emit('update-available', { version: '1.0.61' })
    await new Promise((resolve) => setTimeout(resolve, 0))

    dismissNudge()

    expect(setDismissedUpdateNudgeId).toHaveBeenCalledWith('campaign-1')
    expect(setPendingUpdateNudgeId).toHaveBeenCalledWith(null)
  })

  // Why: issue #631 — the Windows auto-updater fails because installed
  // versions signed with the wrong certificate have a stale publisherName
  // in app-update.yml. verifyUpdateCodeSignature must be overridden on
  // Windows so electron-updater skips Authenticode verification.
  it('overrides verifyUpdateCodeSignature on Windows to skip signing verification', async () => {
    vi.stubGlobal('process', { ...process, platform: 'win32' })

    const { setupAutoUpdater } = await import('./updater')

    const sendMock = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }

    setupAutoUpdater(mainWindow as never)

    // The override should be set on the autoUpdater mock
    const override = (autoUpdaterMock as Record<string, unknown>).verifyUpdateCodeSignature
    expect(override).toBeTypeOf('function')
    // Calling it should resolve to null (meaning "signature valid, skip check")
    await expect((override as () => Promise<string | null>)()).resolves.toBeNull()
  })

  it('does not override verifyUpdateCodeSignature on non-Windows platforms', async () => {
    vi.stubGlobal('process', { ...process, platform: 'darwin' })

    const { setupAutoUpdater } = await import('./updater')

    const sendMock = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }

    setupAutoUpdater(mainWindow as never)

    expect((autoUpdaterMock as Record<string, unknown>).verifyUpdateCodeSignature).toBeUndefined()
  })

  // Why: a prerelease user (e.g. 1.3.17-rc.1) must be able to upgrade to BOTH
  // a newer RC (1.3.17-rc.2) and a newer stable (1.3.18). We solve this by
  // resolving the newest tag ourselves from the atom feed and pinning the
  // generic feed at /releases/download/<tag>/. Using electron-updater's
  // native github provider with allowPrerelease would filter out stable
  // releases for RC users, trapping them on the RC channel.
  it('repins the generic feed to the newest RC tag for a prerelease user', async () => {
    appMock.getVersion.mockReturnValue('1.3.17-rc.1')
    fetchNewerReleaseTagMock.mockResolvedValue('v1.3.17-rc.2')
    autoUpdaterMock.checkForUpdates.mockResolvedValue(undefined)

    const { setupAutoUpdater, checkForUpdatesFromMenu } = await import('./updater')

    const mainWindow = { webContents: { send: vi.fn() } }
    setupAutoUpdater(mainWindow as never, { getLastUpdateCheckAt: () => Date.now() })

    // Setup pins the default generic feed; resolver only runs per check.
    expect(autoUpdaterMock.setFeedURL).toHaveBeenLastCalledWith({
      provider: 'generic',
      url: 'https://github.com/stablyai/orca/releases/latest/download'
    })
    expect(autoUpdaterMock.allowPrerelease).not.toBe(true)

    checkForUpdatesFromMenu()

    await vi.waitFor(() => {
      expect(fetchNewerReleaseTagMock).toHaveBeenCalledWith('1.3.17-rc.1')
      expect(autoUpdaterMock.setFeedURL).toHaveBeenLastCalledWith({
        provider: 'generic',
        url: 'https://github.com/stablyai/orca/releases/download/v1.3.17-rc.2'
      })
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)
    })
  })

  // Why: the original bug in PR #1053 was that RC users couldn't upgrade to a
  // newer stable release. The resolver must pick that stable tag for a
  // prerelease user so the 'update-available' event fires against it.
  it('repins the generic feed to a newer stable tag for a prerelease user', async () => {
    appMock.getVersion.mockReturnValue('1.3.19-rc.6')
    fetchNewerReleaseTagMock.mockResolvedValue('v1.3.19')
    autoUpdaterMock.checkForUpdates.mockResolvedValue(undefined)

    const { setupAutoUpdater, checkForUpdatesFromMenu } = await import('./updater')

    const mainWindow = { webContents: { send: vi.fn() } }
    setupAutoUpdater(mainWindow as never, { getLastUpdateCheckAt: () => Date.now() })

    checkForUpdatesFromMenu()

    await vi.waitFor(() => {
      expect(autoUpdaterMock.setFeedURL).toHaveBeenLastCalledWith({
        provider: 'generic',
        url: 'https://github.com/stablyai/orca/releases/download/v1.3.19'
      })
    })
    expect(autoUpdaterMock.allowPrerelease).not.toBe(true)
  })

  // Why: if the atom-feed resolver fails or finds nothing newer, we must
  // fall back to the default /releases/latest/download/ feed so the check
  // can still complete and report "not-available" (rather than error out).
  it('falls back to /releases/latest/download when the atom resolver returns null', async () => {
    appMock.getVersion.mockReturnValue('1.3.19-rc.6')
    fetchNewerReleaseTagMock.mockResolvedValue(null)
    autoUpdaterMock.checkForUpdates.mockResolvedValue(undefined)

    const { setupAutoUpdater, checkForUpdatesFromMenu } = await import('./updater')

    const mainWindow = { webContents: { send: vi.fn() } }
    setupAutoUpdater(mainWindow as never, { getLastUpdateCheckAt: () => Date.now() })

    checkForUpdatesFromMenu()

    await vi.waitFor(() => {
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)
    })
    expect(autoUpdaterMock.setFeedURL).toHaveBeenLastCalledWith({
      provider: 'generic',
      url: 'https://github.com/stablyai/orca/releases/latest/download'
    })
  })

  it('does not invoke the atom-feed resolver for a stable user', async () => {
    appMock.getVersion.mockReturnValue('1.3.17')
    autoUpdaterMock.checkForUpdates.mockResolvedValue(undefined)

    const { setupAutoUpdater, checkForUpdatesFromMenu } = await import('./updater')

    const mainWindow = { webContents: { send: vi.fn() } }
    setupAutoUpdater(mainWindow as never, { getLastUpdateCheckAt: () => Date.now() })

    checkForUpdatesFromMenu()

    await vi.waitFor(() => {
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)
    })
    expect(fetchNewerReleaseTagMock).not.toHaveBeenCalled()
    expect(autoUpdaterMock.setFeedURL).toHaveBeenCalledWith({
      provider: 'generic',
      url: 'https://github.com/stablyai/orca/releases/latest/download'
    })
  })

  // Why: once the user Shift-clicks to opt into RC channel, we switch to the
  // native github provider. The atom-feed resolver must NOT run after that,
  // or it would clobber the provider switch with a generic feed URL.
  it('does not run the atom resolver after a Shift-click RC opt-in', async () => {
    appMock.getVersion.mockReturnValue('1.3.17')
    autoUpdaterMock.checkForUpdates.mockResolvedValue(undefined)

    const { setupAutoUpdater, checkForUpdatesFromMenu } = await import('./updater')

    const mainWindow = { webContents: { send: vi.fn() } }
    setupAutoUpdater(mainWindow as never, { getLastUpdateCheckAt: () => Date.now() })

    checkForUpdatesFromMenu({ includePrerelease: true })

    await vi.waitFor(() => {
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)
    })
    expect(fetchNewerReleaseTagMock).not.toHaveBeenCalled()
    expect(autoUpdaterMock.allowPrerelease).toBe(true)
    expect(autoUpdaterMock.setFeedURL).toHaveBeenLastCalledWith({
      provider: 'github',
      owner: 'stablyai',
      repo: 'orca'
    })
  })
})
