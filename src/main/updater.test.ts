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
    autoUpdaterMock.updateConfigPath = undefined
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
    updateConfigPath: undefined as string | undefined,
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

vi.mock('./electron-updater-loader', () => ({
  loadElectronAutoUpdater: () => autoUpdaterMock
}))

vi.mock('@electron-toolkit/utils', () => ({
  is: isMock
}))

vi.mock('./ipc/pty', () => ({
  killAllPty: killAllPtyMock
}))

const { fetchChangelogMock } = vi.hoisted(() => ({
  fetchChangelogMock: vi.fn()
}))

vi.mock('./updater-changelog', () => ({
  fetchChangelog: fetchChangelogMock
}))

const { fetchNudgeMock, shouldApplyNudgeMock } = vi.hoisted(() => ({
  fetchNudgeMock: vi.fn(),
  shouldApplyNudgeMock: vi.fn()
}))

vi.mock('./updater-nudge', () => ({
  fetchNudge: fetchNudgeMock,
  shouldApplyNudge: shouldApplyNudgeMock
}))

const { fetchNewerReleaseTagsMock } = vi.hoisted(() => ({
  fetchNewerReleaseTagsMock: vi.fn()
}))

vi.mock('./updater-prerelease-feed', () => ({
  fetchNewerReleaseTagsWithReadiness: async (...args: unknown[]) => {
    const result = await fetchNewerReleaseTagsMock(...args)
    return Array.isArray(result)
      ? { tags: result, state: result.length > 0 ? 'ready' : 'no-newer' }
      : result
  },
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
    fetchChangelogMock.mockReset().mockResolvedValue(null)
    fetchNewerReleaseTagsMock.mockReset().mockResolvedValue([])
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('does not load or configure electron-updater during dev setup', async () => {
    isMock.dev = true
    const mainWindow = { webContents: { send: vi.fn() } }

    const { setupAutoUpdater } = await import('./updater')

    setupAutoUpdater(mainWindow as never)

    // Why: E2E launches use dev mode and Electron's direct script runner, whose
    // default app version makes electron-updater throw during module load.
    expect(autoUpdaterMock.updateConfigPath).toBeUndefined()
    expect(autoUpdaterMock.setFeedURL).not.toHaveBeenCalled()
    expect(autoUpdaterMock.checkForUpdates).not.toHaveBeenCalled()
    expect(powerMonitorOnMock).not.toHaveBeenCalled()
  })

  it('deduplicates identical check errors from the event and rejected promise', async () => {
    autoUpdaterMock.checkForUpdates.mockImplementation(() => {
      autoUpdaterMock.emit('checking-for-update')
      queueMicrotask(() => {
        autoUpdaterMock.emit('error', new Error('boom'))
      })
      return Promise.reject(new Error('boom'))
    })

    const sendMock = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }

    const { setupAutoUpdater, checkForUpdatesFromMenu } = await import('./updater')

    setupAutoUpdater(mainWindow as never, { getLastUpdateCheckAt: () => Date.now() })
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
    autoUpdaterMock.checkForUpdates.mockImplementation(() => {
      autoUpdaterMock.emit('checking-for-update')
      queueMicrotask(() => {
        autoUpdaterMock.emit('error', new Error('net::ERR_FAILED'))
      })
      return Promise.reject(new Error('net::ERR_FAILED'))
    })

    const sendMock = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }

    const { setupAutoUpdater, checkForUpdatesFromMenu } = await import('./updater')

    setupAutoUpdater(mainWindow as never, { getLastUpdateCheckAt: () => Date.now() })
    checkForUpdatesFromMenu()
    await vi.waitFor(() => {
      const statuses = sendMock.mock.calls
        .filter(([channel]) => channel === 'updater:status')
        .map(([, status]) => status)
      expect(statuses).toContainEqual(
        expect.objectContaining({
          state: 'error',
          userInitiated: true,
          message: expect.stringContaining("Couldn't reach the update server")
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

  it('shows checking immediately for a user-initiated check while feed pinning is pending', async () => {
    let resolveTags: (value: { tags: string[]; state: 'no-newer' }) => void = () => {}
    fetchNewerReleaseTagsMock.mockImplementation(
      () =>
        new Promise<{ tags: string[]; state: 'no-newer' }>((resolve) => {
          resolveTags = resolve
        })
    )
    autoUpdaterMock.checkForUpdates.mockImplementation(() => {
      autoUpdaterMock.emit('checking-for-update')
      return new Promise(() => {})
    })
    const sendMock = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }

    const { setupAutoUpdater, checkForUpdatesFromMenu } = await import('./updater')

    setupAutoUpdater(mainWindow as never, { getLastUpdateCheckAt: () => Date.now() })
    checkForUpdatesFromMenu()

    expect(sendMock).toHaveBeenCalledWith('updater:status', {
      state: 'checking',
      userInitiated: true
    })
    expect(autoUpdaterMock.checkForUpdates).not.toHaveBeenCalled()

    resolveTags({ tags: [], state: 'no-newer' })
    await vi.waitFor(() => {
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)
    })

    const checkingStatuses = sendMock.mock.calls
      .filter(([channel]) => channel === 'updater:status')
      .map(([, status]) => status)
      .filter(
        (status) => typeof status === 'object' && status !== null && status.state === 'checking'
      )

    expect(checkingStatuses).toEqual([{ state: 'checking', userInitiated: true }])
  })

  it('keeps background checks event-driven before checking-for-update fires', async () => {
    let resolveTags: (value: { tags: string[]; state: 'no-newer' }) => void = () => {}
    fetchNewerReleaseTagsMock.mockImplementation(
      () =>
        new Promise<{ tags: string[]; state: 'no-newer' }>((resolve) => {
          resolveTags = resolve
        })
    )
    autoUpdaterMock.checkForUpdates.mockImplementation(() => new Promise(() => {}))
    const sendMock = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }

    const { setupAutoUpdater } = await import('./updater')

    setupAutoUpdater(mainWindow as never, { getLastUpdateCheckAt: () => null })

    expect(
      sendMock.mock.calls
        .filter(([channel]) => channel === 'updater:status')
        .map(([, status]) => status)
        .some(
          (status) => typeof status === 'object' && status !== null && status.state === 'checking'
        )
    ).toBe(false)

    resolveTags({ tags: [], state: 'no-newer' })
    await vi.waitFor(() => {
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)
    })

    autoUpdaterMock.emit('checking-for-update')
    expect(sendMock).toHaveBeenCalledWith(
      'updater:status',
      expect.objectContaining({ state: 'checking' })
    )
  })

  it('promotes a pending background check to user-initiated without launching a duplicate check', async () => {
    let resolveTags: (value: { tags: string[]; state: 'no-newer' }) => void = () => {}
    fetchNewerReleaseTagsMock.mockImplementation(
      () =>
        new Promise<{ tags: string[]; state: 'no-newer' }>((resolve) => {
          resolveTags = resolve
        })
    )
    autoUpdaterMock.checkForUpdates.mockResolvedValue(undefined)
    const sendMock = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }

    const { setupAutoUpdater, checkForUpdatesFromMenu } = await import('./updater')

    setupAutoUpdater(mainWindow as never, { getLastUpdateCheckAt: () => null })
    checkForUpdatesFromMenu()

    expect(sendMock).toHaveBeenCalledWith('updater:status', {
      state: 'checking',
      userInitiated: true
    })
    expect(autoUpdaterMock.checkForUpdates).not.toHaveBeenCalled()

    resolveTags({ tags: [], state: 'no-newer' })
    await vi.waitFor(() => {
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)
    })

    autoUpdaterMock.emit('checking-for-update')
    autoUpdaterMock.emit('update-not-available')
    expect(sendMock).toHaveBeenCalledWith('updater:status', {
      state: 'not-available',
      userInitiated: true
    })
  })

  it('keeps a silent background settle user-initiated after menu promotion', async () => {
    vi.useFakeTimers()
    fetchNewerReleaseTagsMock.mockResolvedValue({ tags: [], state: 'no-newer' })
    autoUpdaterMock.checkForUpdates.mockResolvedValue(undefined)
    const sendMock = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }

    const { setupAutoUpdater, checkForUpdatesFromMenu } = await import('./updater')

    setupAutoUpdater(mainWindow as never, { getLastUpdateCheckAt: () => null })

    await vi.waitFor(() => {
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)
    })
    await vi.advanceTimersByTimeAsync(0)

    sendMock.mockClear()
    checkForUpdatesFromMenu()

    expect(sendMock).toHaveBeenCalledWith('updater:status', {
      state: 'checking',
      userInitiated: true
    })

    await vi.advanceTimersByTimeAsync(1000)

    expect(sendMock).toHaveBeenCalledWith('updater:status', {
      state: 'not-available',
      userInitiated: true
    })
  })

  it('settles a manual check when electron-updater resolves without a terminal event', async () => {
    vi.useFakeTimers()
    fetchNewerReleaseTagsMock.mockResolvedValue({ tags: [], state: 'no-newer' })
    autoUpdaterMock.checkForUpdates.mockResolvedValue(undefined)
    const sendMock = vi.fn()
    const setLastUpdateCheckAt = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }

    const { setupAutoUpdater, checkForUpdatesFromMenu } = await import('./updater')

    setupAutoUpdater(mainWindow as never, {
      getLastUpdateCheckAt: () => Date.now(),
      setLastUpdateCheckAt
    })
    checkForUpdatesFromMenu()

    await vi.waitFor(() => {
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)
    })
    await vi.advanceTimersByTimeAsync(1000)

    expect(sendMock).toHaveBeenCalledWith('updater:status', {
      state: 'not-available',
      userInitiated: true
    })
    expect(setLastUpdateCheckAt).toHaveBeenCalledTimes(1)
  })

  it('ignores a stale update-available event after a silent background settle', async () => {
    vi.useFakeTimers()
    fetchNewerReleaseTagsMock.mockResolvedValue({ tags: [], state: 'no-newer' })
    autoUpdaterMock.checkForUpdates.mockResolvedValue(undefined)
    const sendMock = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }

    const { setupAutoUpdater } = await import('./updater')

    setupAutoUpdater(mainWindow as never, {
      getLastUpdateCheckAt: () => null,
      setLastUpdateCheckAt: vi.fn()
    })

    await vi.waitFor(() => {
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)
    })
    await vi.advanceTimersByTimeAsync(1000)

    autoUpdaterMock.emit('update-available', { version: '1.0.61' })
    await vi.advanceTimersByTimeAsync(0)

    expect(fetchChangelogMock).not.toHaveBeenCalled()
    expect(sendMock).not.toHaveBeenCalledWith(
      'updater:status',
      expect.objectContaining({ state: 'available', version: '1.0.61' })
    )
  })

  it('ignores a stale checking-for-update event after a silent manual settle', async () => {
    vi.useFakeTimers()
    fetchNewerReleaseTagsMock.mockResolvedValue({ tags: [], state: 'no-newer' })
    autoUpdaterMock.checkForUpdates.mockResolvedValue(undefined)
    const sendMock = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }

    const { setupAutoUpdater, checkForUpdatesFromMenu } = await import('./updater')

    setupAutoUpdater(mainWindow as never, { getLastUpdateCheckAt: () => Date.now() })
    checkForUpdatesFromMenu()

    await vi.waitFor(() => {
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)
    })
    await vi.advanceTimersByTimeAsync(1000)

    sendMock.mockClear()
    autoUpdaterMock.emit('checking-for-update')

    expect(sendMock).not.toHaveBeenCalled()
  })

  it('ignores stale updater events while a new check is still in feed preflight', async () => {
    vi.useFakeTimers()
    let resolveSecondTags: (value: { tags: string[]; state: 'no-newer' }) => void = () => {}
    fetchNewerReleaseTagsMock
      .mockResolvedValueOnce({ tags: [], state: 'no-newer' })
      .mockImplementationOnce(
        () =>
          new Promise<{ tags: string[]; state: 'no-newer' }>((resolve) => {
            resolveSecondTags = resolve
          })
      )
    autoUpdaterMock.checkForUpdates.mockResolvedValue(undefined)
    const sendMock = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }

    const { setupAutoUpdater, checkForUpdatesFromMenu } = await import('./updater')

    setupAutoUpdater(mainWindow as never, { getLastUpdateCheckAt: () => Date.now() })
    checkForUpdatesFromMenu()

    await vi.waitFor(() => {
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)
    })
    await vi.advanceTimersByTimeAsync(1000)

    sendMock.mockClear()
    checkForUpdatesFromMenu()
    await vi.waitFor(() => {
      expect(fetchNewerReleaseTagsMock).toHaveBeenCalledTimes(2)
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)
    })

    autoUpdaterMock.emit('checking-for-update')
    autoUpdaterMock.emit('update-not-available')

    expect(sendMock).not.toHaveBeenCalledWith('updater:status', {
      state: 'not-available',
      userInitiated: true
    })

    resolveSecondTags({ tags: [], state: 'no-newer' })
    await vi.waitFor(() => {
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(2)
    })
    autoUpdaterMock.emit('checking-for-update')
    autoUpdaterMock.emit('update-not-available')

    expect(sendMock).toHaveBeenCalledWith('updater:status', {
      state: 'not-available',
      userInitiated: true
    })
  })

  it('does not let a stale silent settle finish a later manual check', async () => {
    vi.useFakeTimers()
    fetchNewerReleaseTagsMock.mockResolvedValue({ tags: [], state: 'no-newer' })
    autoUpdaterMock.checkForUpdates.mockImplementation(() => {
      const callCount = autoUpdaterMock.checkForUpdates.mock.calls.length
      autoUpdaterMock.emit('checking-for-update')
      if (callCount === 1) {
        queueMicrotask(() => {
          autoUpdaterMock.emit('update-not-available')
        })
        return Promise.resolve(undefined)
      }
      return new Promise(() => {})
    })
    const sendMock = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }

    const { setupAutoUpdater, checkForUpdatesFromMenu } = await import('./updater')

    setupAutoUpdater(mainWindow as never, { getLastUpdateCheckAt: () => Date.now() })
    checkForUpdatesFromMenu()

    await vi.waitFor(() => {
      expect(sendMock).toHaveBeenCalledWith('updater:status', {
        state: 'not-available',
        userInitiated: true
      })
    })

    sendMock.mockClear()
    checkForUpdatesFromMenu()
    await vi.waitFor(() => {
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(2)
      expect(sendMock).toHaveBeenCalledWith('updater:status', {
        state: 'checking',
        userInitiated: true
      })
    })

    await vi.advanceTimersByTimeAsync(1000)

    expect(sendMock).not.toHaveBeenCalledWith('updater:status', {
      state: 'not-available',
      userInitiated: true
    })
  })

  it('does not let a stale pending update-available block a later silent settle', async () => {
    vi.useFakeTimers()
    let resolveChangelog: (value: null) => void = () => {}
    fetchChangelogMock.mockImplementation(
      () =>
        new Promise<null>((resolve) => {
          resolveChangelog = resolve
        })
    )
    fetchNewerReleaseTagsMock.mockResolvedValue({ tags: ['v1.0.52'], state: 'ready' })
    autoUpdaterMock.checkForUpdates.mockImplementation(() => {
      const callCount = autoUpdaterMock.checkForUpdates.mock.calls.length
      autoUpdaterMock.emit('checking-for-update')
      if (callCount === 1) {
        queueMicrotask(() => {
          autoUpdaterMock.emit('update-available', { version: '1.0.52' })
        })
      }
      return Promise.resolve(undefined)
    })
    const sendMock = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }

    const { setupAutoUpdater, checkForUpdatesFromMenu } = await import('./updater')

    setupAutoUpdater(mainWindow as never, { getLastUpdateCheckAt: () => Date.now() })
    checkForUpdatesFromMenu()

    await vi.waitFor(() => {
      expect(fetchChangelogMock).toHaveBeenCalledTimes(1)
    })

    autoUpdaterMock.emit('error', new Error('boom'))
    await vi.waitFor(() => {
      expect(sendMock).toHaveBeenCalledWith('updater:status', {
        state: 'error',
        message: 'boom',
        userInitiated: undefined
      })
    })

    sendMock.mockClear()
    checkForUpdatesFromMenu()
    await vi.waitFor(() => {
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(2)
      expect(sendMock).toHaveBeenCalledWith('updater:status', {
        state: 'checking',
        userInitiated: true
      })
    })

    await vi.advanceTimersByTimeAsync(1000)

    expect(sendMock).toHaveBeenCalledWith('updater:status', {
      state: 'not-available',
      userInitiated: true
    })

    sendMock.mockClear()
    resolveChangelog(null)
    await vi.advanceTimersByTimeAsync(0)

    expect(sendMock).not.toHaveBeenCalledWith(
      'updater:status',
      expect.objectContaining({ state: 'available', version: '1.0.52' })
    )
  })

  it('ignores a stale update-available event after a new check starts preflight', async () => {
    vi.useFakeTimers()
    fetchNewerReleaseTagsMock.mockResolvedValue({ tags: [], state: 'no-newer' })
    autoUpdaterMock.checkForUpdates.mockImplementation(() => {
      if (autoUpdaterMock.checkForUpdates.mock.calls.length === 1) {
        return Promise.resolve(undefined)
      }
      return new Promise(() => {})
    })
    const sendMock = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }

    const { setupAutoUpdater, checkForUpdatesFromMenu } = await import('./updater')

    setupAutoUpdater(mainWindow as never, { getLastUpdateCheckAt: () => Date.now() })
    checkForUpdatesFromMenu()

    await vi.waitFor(() => {
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)
    })
    await vi.advanceTimersByTimeAsync(1000)

    sendMock.mockClear()
    checkForUpdatesFromMenu()
    await vi.waitFor(() => {
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(2)
      expect(sendMock).toHaveBeenCalledWith('updater:status', {
        state: 'checking',
        userInitiated: true
      })
    })

    autoUpdaterMock.emit('update-available', { version: '1.0.61' })
    await vi.advanceTimersByTimeAsync(0)

    expect(fetchChangelogMock).not.toHaveBeenCalled()
    expect(sendMock).not.toHaveBeenCalledWith(
      'updater:status',
      expect.objectContaining({ state: 'available', version: '1.0.61' })
    )
  })

  it('ignores a stale update-not-available event after a new check starts preflight', async () => {
    vi.useFakeTimers()
    fetchNewerReleaseTagsMock.mockResolvedValue({ tags: [], state: 'no-newer' })
    autoUpdaterMock.checkForUpdates.mockImplementation(() => {
      if (autoUpdaterMock.checkForUpdates.mock.calls.length === 1) {
        return Promise.resolve(undefined)
      }
      return new Promise(() => {})
    })
    const sendMock = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }

    const { setupAutoUpdater, checkForUpdatesFromMenu } = await import('./updater')

    setupAutoUpdater(mainWindow as never, { getLastUpdateCheckAt: () => Date.now() })
    checkForUpdatesFromMenu()

    await vi.waitFor(() => {
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)
    })
    await vi.advanceTimersByTimeAsync(1000)

    sendMock.mockClear()
    checkForUpdatesFromMenu()
    await vi.waitFor(() => {
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(2)
      expect(sendMock).toHaveBeenCalledWith('updater:status', {
        state: 'checking',
        userInitiated: true
      })
    })

    autoUpdaterMock.emit('update-not-available')

    expect(sendMock).not.toHaveBeenCalledWith('updater:status', {
      state: 'not-available',
      userInitiated: true
    })
  })

  it('ignores a stale error event after a new check starts preflight', async () => {
    vi.useFakeTimers()
    let resolveSecondTags: (value: { tags: string[]; state: 'no-newer' }) => void = () => {}
    fetchNewerReleaseTagsMock
      .mockResolvedValueOnce({ tags: [], state: 'no-newer' })
      .mockImplementationOnce(
        () =>
          new Promise<{ tags: string[]; state: 'no-newer' }>((resolve) => {
            resolveSecondTags = resolve
          })
      )
    autoUpdaterMock.checkForUpdates.mockResolvedValue(undefined)
    const sendMock = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }

    const { setupAutoUpdater, checkForUpdatesFromMenu } = await import('./updater')

    setupAutoUpdater(mainWindow as never, { getLastUpdateCheckAt: () => Date.now() })
    checkForUpdatesFromMenu()

    await vi.waitFor(() => {
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)
    })
    await vi.advanceTimersByTimeAsync(1000)

    sendMock.mockClear()
    checkForUpdatesFromMenu()
    await vi.waitFor(() => {
      expect(fetchNewerReleaseTagsMock).toHaveBeenCalledTimes(2)
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)
    })

    autoUpdaterMock.emit('error', new Error('stale boom'))

    expect(sendMock).not.toHaveBeenCalledWith(
      'updater:status',
      expect.objectContaining({ state: 'error', message: 'stale boom' })
    )

    resolveSecondTags({ tags: [], state: 'no-newer' })
    await vi.waitFor(() => {
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(2)
    })
    autoUpdaterMock.emit('checking-for-update')
    autoUpdaterMock.emit('update-not-available')

    expect(sendMock).toHaveBeenCalledWith('updater:status', {
      state: 'not-available',
      userInitiated: true
    })
  })

  it('times out a manual preflight that never reaches electron-updater events', async () => {
    vi.useFakeTimers()
    fetchNewerReleaseTagsMock.mockImplementation(() => new Promise(() => {}))
    const sendMock = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }

    const { setupAutoUpdater, checkForUpdatesFromMenu } = await import('./updater')

    setupAutoUpdater(mainWindow as never, { getLastUpdateCheckAt: () => Date.now() })
    checkForUpdatesFromMenu()

    expect(sendMock).toHaveBeenCalledWith('updater:status', {
      state: 'checking',
      userInitiated: true
    })
    await vi.advanceTimersByTimeAsync(45 * 1000)

    expect(autoUpdaterMock.checkForUpdates).not.toHaveBeenCalled()
    expect(sendMock).toHaveBeenCalledWith('updater:status', {
      state: 'error',
      message: 'Update check timed out. Try again in a few minutes.',
      userInitiated: true
    })
  })

  it('does not launch electron-updater after a manual preflight timeout settles', async () => {
    vi.useFakeTimers()
    let resolveTags: (value: { tags: string[]; state: 'no-newer' }) => void = () => {}
    fetchNewerReleaseTagsMock.mockImplementation(
      () =>
        new Promise<{ tags: string[]; state: 'no-newer' }>((resolve) => {
          resolveTags = resolve
        })
    )
    autoUpdaterMock.checkForUpdates.mockResolvedValue(undefined)
    const sendMock = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }

    const { setupAutoUpdater, checkForUpdatesFromMenu } = await import('./updater')

    setupAutoUpdater(mainWindow as never, { getLastUpdateCheckAt: () => Date.now() })
    checkForUpdatesFromMenu()

    await vi.advanceTimersByTimeAsync(45 * 1000)
    expect(sendMock).toHaveBeenCalledWith('updater:status', {
      state: 'error',
      message: 'Update check timed out. Try again in a few minutes.',
      userInitiated: true
    })

    resolveTags({ tags: [], state: 'no-newer' })
    await vi.advanceTimersByTimeAsync(0)

    expect(autoUpdaterMock.checkForUpdates).not.toHaveBeenCalled()
  })

  it('runs a fresh prerelease check when Shift-click promotes an in-flight stable check', async () => {
    vi.useFakeTimers()
    let resolveStableTags: (value: { tags: string[]; state: 'no-newer' }) => void = () => {}
    let resolveStableCheck: () => void = () => {}
    fetchNewerReleaseTagsMock
      .mockImplementationOnce(
        () =>
          new Promise<{ tags: string[]; state: 'no-newer' }>((resolve) => {
            resolveStableTags = resolve
          })
      )
      .mockResolvedValueOnce({ tags: ['v1.4.36-rc.5'], state: 'ready' })
    autoUpdaterMock.checkForUpdates
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            resolveStableCheck = resolve
          })
      )
      .mockResolvedValueOnce(undefined)
    const sendMock = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }

    const { setupAutoUpdater, checkForUpdatesFromMenu } = await import('./updater')

    appMock.getVersion.mockReturnValue('1.4.35')
    setupAutoUpdater(mainWindow as never, { getLastUpdateCheckAt: () => null })
    checkForUpdatesFromMenu({ includePrerelease: true })

    expect(sendMock).toHaveBeenCalledWith('updater:status', {
      state: 'checking',
      userInitiated: true
    })
    expect(autoUpdaterMock.checkForUpdates).not.toHaveBeenCalled()

    resolveStableTags({ tags: [], state: 'no-newer' })
    await vi.waitFor(() => {
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)
    })

    autoUpdaterMock.emit('checking-for-update')
    autoUpdaterMock.emit('update-not-available')
    await vi.advanceTimersByTimeAsync(0)
    resolveStableCheck()

    await vi.waitFor(() => {
      expect(fetchNewerReleaseTagsMock).toHaveBeenCalledWith('1.4.35', 2, {
        includePrerelease: true
      })
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(2)
    })
    expect(autoUpdaterMock.setFeedURL).toHaveBeenLastCalledWith({
      provider: 'generic',
      url: 'https://github.com/stablyai/orca/releases/download/v1.4.36-rc.5'
    })
    expect(
      sendMock.mock.calls
        .filter(([channel]) => channel === 'updater:status')
        .map(([, status]) => status)
    ).not.toContainEqual({ state: 'not-available', userInitiated: true })
  })

  it('keeps promoted background promise failures user-initiated after a paired error event', async () => {
    let resolveTags: (value: { tags: string[]; state: 'no-newer' }) => void = () => {}
    fetchNewerReleaseTagsMock.mockImplementation(
      () =>
        new Promise<{ tags: string[]; state: 'no-newer' }>((resolve) => {
          resolveTags = resolve
        })
    )
    autoUpdaterMock.checkForUpdates.mockImplementation(() => {
      autoUpdaterMock.emit('checking-for-update')
      queueMicrotask(() => {
        autoUpdaterMock.emit('error', new Error('net::ERR_FAILED'))
      })
      return Promise.reject(new Error('net::ERR_FAILED'))
    })
    const sendMock = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }

    const { setupAutoUpdater, checkForUpdatesFromMenu } = await import('./updater')

    setupAutoUpdater(mainWindow as never, { getLastUpdateCheckAt: () => null })
    checkForUpdatesFromMenu()
    resolveTags({ tags: [], state: 'no-newer' })

    await vi.waitFor(() => {
      const statuses = sendMock.mock.calls
        .filter(([channel]) => channel === 'updater:status')
        .map(([, status]) => status)
      expect(statuses).toContainEqual(
        expect.objectContaining({
          state: 'error',
          userInitiated: true,
          message: expect.stringContaining("Couldn't reach the update server")
        })
      )
    })

    const resultStatuses = sendMock.mock.calls
      .filter(([channel]) => channel === 'updater:status')
      .map(([, status]) => status)
      .filter(
        (status) =>
          typeof status === 'object' &&
          status !== null &&
          (status.state === 'idle' || status.state === 'error')
      )

    expect(resultStatuses).toEqual([
      expect.objectContaining({
        state: 'error',
        userInitiated: true,
        message: expect.stringContaining("Couldn't reach the update server")
      })
    ])
  })

  it('deduplicates repeated manual checks while the immediate checking status is active', async () => {
    let resolveTags: (value: { tags: string[]; state: 'no-newer' }) => void = () => {}
    fetchNewerReleaseTagsMock.mockImplementation(
      () =>
        new Promise<{ tags: string[]; state: 'no-newer' }>((resolve) => {
          resolveTags = resolve
        })
    )
    autoUpdaterMock.checkForUpdates.mockImplementation(() => new Promise(() => {}))
    const mainWindow = { webContents: { send: vi.fn() } }

    const { setupAutoUpdater, checkForUpdatesFromMenu } = await import('./updater')

    setupAutoUpdater(mainWindow as never, { getLastUpdateCheckAt: () => Date.now() })
    checkForUpdatesFromMenu()
    checkForUpdatesFromMenu()

    resolveTags({ tags: [], state: 'no-newer' })
    await vi.waitFor(() => {
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)
    })
    expect(fetchNewerReleaseTagsMock).toHaveBeenCalledTimes(1)
  })

  it('opts into the RC channel when checkForUpdatesFromMenu is called with includePrerelease', async () => {
    appMock.getVersion.mockReturnValue('1.3.17')
    fetchNewerReleaseTagsMock.mockResolvedValue(['v1.3.18-rc.1'])
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

    await vi.waitFor(() => {
      expect(fetchNewerReleaseTagsMock).toHaveBeenCalledWith('1.3.17', 2, {
        includePrerelease: true
      })
      expect(autoUpdaterMock.setFeedURL).toHaveBeenLastCalledWith({
        provider: 'generic',
        url: 'https://github.com/stablyai/orca/releases/download/v1.3.18-rc.1'
      })
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)
    })
    expect(autoUpdaterMock.allowPrerelease).toBe(true)
    expect(autoUpdaterMock.setFeedURL.mock.calls.length).toBe(setupFeedUrlCalls + 1)
  })

  it('pins the generic feed to a perf-tagged prerelease when requested', async () => {
    appMock.getVersion.mockReturnValue('1.4.120')
    fetchNewerReleaseTagsMock.mockResolvedValue(['v1.4.121-rc.6.perf'])
    autoUpdaterMock.checkForUpdates.mockResolvedValue(undefined)
    const mainWindow = { webContents: { send: vi.fn() } }

    const { setupAutoUpdater, checkForUpdatesFromMenu } = await import('./updater')

    setupAutoUpdater(mainWindow as never, { getLastUpdateCheckAt: () => Date.now() })

    checkForUpdatesFromMenu({ includePerfPrerelease: true })

    await vi.waitFor(() => {
      expect(fetchNewerReleaseTagsMock).toHaveBeenCalledWith('1.4.120', 2, {
        includePrerelease: true,
        releaseFilter: 'perf'
      })
      expect(autoUpdaterMock.setFeedURL).toHaveBeenLastCalledWith({
        provider: 'generic',
        url: 'https://github.com/stablyai/orca/releases/download/v1.4.121-rc.6.perf'
      })
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)
    })
    expect(autoUpdaterMock.allowPrerelease).toBe(true)
  })

  it('surfaces no-update feedback when no newer perf-tagged prerelease exists', async () => {
    appMock.getVersion.mockReturnValue('1.4.120')
    fetchNewerReleaseTagsMock.mockResolvedValue({ tags: [], state: 'no-newer' })
    autoUpdaterMock.checkForUpdates.mockResolvedValue(undefined)
    const sendMock = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }

    const { setupAutoUpdater, checkForUpdatesFromMenu } = await import('./updater')

    setupAutoUpdater(mainWindow as never, { getLastUpdateCheckAt: () => Date.now() })
    const setupFeedUrlCalls = autoUpdaterMock.setFeedURL.mock.calls.length

    checkForUpdatesFromMenu({ includePerfPrerelease: true })

    await vi.waitFor(() => {
      expect(sendMock).toHaveBeenCalledWith('updater:status', {
        state: 'not-available',
        userInitiated: true
      })
    })
    expect(fetchNewerReleaseTagsMock).toHaveBeenCalledWith('1.4.120', 2, {
      includePrerelease: true,
      releaseFilter: 'perf'
    })
    expect(autoUpdaterMock.checkForUpdates).not.toHaveBeenCalled()
    expect(autoUpdaterMock.setFeedURL.mock.calls.length).toBe(setupFeedUrlCalls)
  })

  it('keeps background retries on the stable channel after a perf publishing-window miss', async () => {
    vi.useFakeTimers()
    appMock.getVersion.mockReturnValue('1.4.120')
    fetchNewerReleaseTagsMock
      .mockResolvedValueOnce({ tags: [], state: 'not-ready' })
      .mockResolvedValueOnce(['v1.4.121'])
    autoUpdaterMock.checkForUpdates.mockResolvedValue(undefined)
    const sendMock = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }

    const { setupAutoUpdater, checkForUpdatesFromMenu } = await import('./updater')

    setupAutoUpdater(mainWindow as never, { getLastUpdateCheckAt: () => Date.now() })

    checkForUpdatesFromMenu({ includePerfPrerelease: true })

    await vi.waitFor(() => {
      expect(sendMock).toHaveBeenCalledWith('updater:status', {
        state: 'error',
        message: "Couldn't reach the update server. Try again in a few minutes.",
        userInitiated: true
      })
    })

    await vi.advanceTimersByTimeAsync(60 * 60 * 1000)

    await vi.waitFor(() => {
      expect(fetchNewerReleaseTagsMock).toHaveBeenNthCalledWith(2, '1.4.120', 1, {
        includePrerelease: false
      })
      expect(autoUpdaterMock.setFeedURL).toHaveBeenLastCalledWith({
        provider: 'generic',
        url: 'https://github.com/stablyai/orca/releases/download/v1.4.121'
      })
    })
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

  it('still surfaces updater error events while a download is in flight', async () => {
    fetchNewerReleaseTagsMock.mockResolvedValue({ tags: ['v1.0.61'], state: 'ready' })
    autoUpdaterMock.checkForUpdates.mockImplementation(() => {
      autoUpdaterMock.emit('checking-for-update')
      queueMicrotask(() => {
        autoUpdaterMock.emit('update-available', { version: '1.0.61' })
      })
      return Promise.resolve(undefined)
    })
    autoUpdaterMock.downloadUpdate.mockImplementation(() => {
      autoUpdaterMock.emit('error', new Error('download failed'))
      return new Promise(() => {})
    })
    const sendMock = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }

    const { setupAutoUpdater, checkForUpdatesFromMenu, downloadUpdate } = await import('./updater')

    setupAutoUpdater(mainWindow as never, { getLastUpdateCheckAt: () => Date.now() })
    checkForUpdatesFromMenu()

    await vi.waitFor(() => {
      expect(sendMock).toHaveBeenCalledWith('updater:status', {
        state: 'available',
        version: '1.0.61',
        changelog: null
      })
    })

    sendMock.mockClear()
    downloadUpdate()

    expect(autoUpdaterMock.downloadUpdate).toHaveBeenCalledTimes(1)
    expect(sendMock).toHaveBeenCalledWith(
      'updater:status',
      expect.objectContaining({ state: 'error', message: 'download failed' })
    )
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

  it('runs pre-quit cleanup before local PTY cleanup during update install', async () => {
    vi.useFakeTimers()

    const onBeforeQuit = vi.fn()
    const mainWindow = { webContents: { send: vi.fn() } }
    const { setupAutoUpdater, quitAndInstall } = await import('./updater')

    setupAutoUpdater(mainWindow as never, { onBeforeQuit })
    quitAndInstall()

    await vi.advanceTimersByTimeAsync(100)

    expect(onBeforeQuit).toHaveBeenCalledTimes(1)
    expect(killAllPtyMock).toHaveBeenCalledTimes(1)
    expect(onBeforeQuit.mock.invocationCallOrder[0]).toBeLessThan(
      killAllPtyMock.mock.invocationCallOrder[0]
    )
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

  it('ignores duplicate quitAndInstall requests while async pre-quit cleanup is running', async () => {
    vi.useFakeTimers()

    let finishCleanup!: () => void
    const onBeforeQuit = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishCleanup = resolve
        })
    )
    const mainWindow = { webContents: { send: vi.fn() } }
    const { setupAutoUpdater, quitAndInstall } = await import('./updater')

    setupAutoUpdater(mainWindow as never, { onBeforeQuit })
    quitAndInstall()

    await vi.advanceTimersByTimeAsync(100)

    expect(onBeforeQuit).toHaveBeenCalledTimes(1)
    expect(autoUpdaterMock.quitAndInstall).not.toHaveBeenCalled()

    quitAndInstall()
    finishCleanup()
    await vi.advanceTimersByTimeAsync(0)

    expect(onBeforeQuit).toHaveBeenCalledTimes(1)
    expect(autoUpdaterMock.quitAndInstall).toHaveBeenCalledTimes(1)
  })

  it('recovers quit-for-update state on sync quitAndInstall error event without killing PTYs', async () => {
    vi.useFakeTimers()

    autoUpdaterMock.quitAndInstall.mockImplementation(() => {
      // Why: BaseUpdater dispatches 'error' synchronously inside install() for
      // the common "no staged update filepath" path.
      autoUpdaterMock.emit(
        'error',
        new Error("No update filepath provided, can't quit and install")
      )
    })

    const sendMock = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }
    const { setupAutoUpdater, quitAndInstall, isQuittingForUpdate } = await import('./updater')

    setupAutoUpdater(mainWindow as never)
    quitAndInstall()

    await vi.advanceTimersByTimeAsync(100)

    expect(autoUpdaterMock.quitAndInstall).toHaveBeenCalledTimes(1)
    expect(isQuittingForUpdate()).toBe(false)
    // Why: destructive prep runs only after quitAndInstall returns still in
    // progress; sync recovery clears flags first so PTYs stay alive.
    expect(killAllPtyMock).not.toHaveBeenCalled()
    expect(sendMock).toHaveBeenCalledWith(
      'updater:status',
      expect.objectContaining({
        state: 'error',
        message: 'Could not restart to install the update. Quit and reopen Orca, then try again.'
      })
    )
  })

  it('does not recover quit-for-update state from late errors after install commit', async () => {
    const sendMock = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }
    fetchNewerReleaseTagsMock.mockResolvedValue({ tags: ['v1.0.61'], state: 'ready' })
    autoUpdaterMock.checkForUpdates.mockImplementation(() => {
      autoUpdaterMock.emit('checking-for-update')
      queueMicrotask(() => {
        autoUpdaterMock.emit('update-available', { version: '1.0.61' })
      })
      return Promise.resolve(undefined)
    })

    const { setupAutoUpdater, checkForUpdatesFromMenu, quitAndInstall, isQuittingForUpdate } =
      await import('./updater')

    setupAutoUpdater(mainWindow as never, { getLastUpdateCheckAt: () => Date.now() })
    checkForUpdatesFromMenu()

    // Why: put status in downloaded so a naive error handler would otherwise
    // treat a late post-commit error as a download/install UI failure.
    await vi.waitFor(() => {
      expect(sendMock).toHaveBeenCalledWith('updater:status', {
        state: 'available',
        version: '1.0.61',
        changelog: null
      })
    })

    autoUpdaterMock.emit('update-downloaded', { version: '1.0.61' })

    // Why: on macOS install is only "committed" once Squirrel is ready; mark
    // it ready so this test covers the post-commit path on all platforms and
    // the UI can leave the "waiting for Squirrel" downloading state.
    if (process.platform === 'darwin') {
      const nativeDownloadedHandler = nativeUpdaterMock.on.mock.calls.find(
        ([eventName]) => eventName === 'update-downloaded'
      )?.[1] as (() => void) | undefined
      expect(nativeDownloadedHandler).toBeTypeOf('function')
      nativeDownloadedHandler?.()
    }

    await vi.waitFor(() => {
      expect(sendMock).toHaveBeenCalledWith(
        'updater:status',
        expect.objectContaining({ state: 'downloaded', version: '1.0.61' })
      )
    })

    quitAndInstall()
    await vi.waitFor(() => {
      expect(autoUpdaterMock.quitAndInstall).toHaveBeenCalledTimes(1)
    })
    expect(killAllPtyMock).toHaveBeenCalledTimes(1)
    expect(isQuittingForUpdate()).toBe(true)

    sendMock.mockClear()
    autoUpdaterMock.emit('error', new Error('late post-commit install error'))

    expect(isQuittingForUpdate()).toBe(true)
    // Why: handoff still owns the process after commit — no recovery message
    // and no general check/download error status either.
    expect(sendMock).not.toHaveBeenCalled()
  })

  it('does not treat pre-native autoUpdater errors as quitAndInstall recovery', async () => {
    vi.useFakeTimers()

    let finishCleanup!: () => void
    const onBeforeQuit = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishCleanup = resolve
        })
    )
    const sendMock = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }
    const { setupAutoUpdater, quitAndInstall, isQuittingForUpdate } = await import('./updater')

    setupAutoUpdater(mainWindow as never, {
      onBeforeQuit,
      getLastUpdateCheckAt: () => Date.now()
    })
    quitAndInstall()
    await vi.advanceTimersByTimeAsync(100)

    expect(onBeforeQuit).toHaveBeenCalledTimes(1)
    expect(autoUpdaterMock.quitAndInstall).not.toHaveBeenCalled()
    expect(isQuittingForUpdate()).toBe(true)

    sendMock.mockClear()
    // Why: an unrelated error during pre-quit cleanup must not clear
    // quittingForUpdate or emit the install-recovery status (native not invoked).
    autoUpdaterMock.emit('error', new Error('pre-native concurrent error'))

    expect(isQuittingForUpdate()).toBe(true)
    expect(sendMock).not.toHaveBeenCalled()

    finishCleanup()
    await vi.advanceTimersByTimeAsync(0)

    expect(autoUpdaterMock.quitAndInstall).toHaveBeenCalledTimes(1)
    expect(isQuittingForUpdate()).toBe(true)
  })

  it('runs a startup check immediately when the last background check is stale', async () => {
    const mainWindow = { webContents: { send: vi.fn() } }
    const setLastUpdateCheckAt = vi.fn()

    const { setupAutoUpdater } = await import('./updater')

    setupAutoUpdater(mainWindow as never, {
      getLastUpdateCheckAt: () => Date.now() - 25 * 60 * 60 * 1000,
      setLastUpdateCheckAt
    })

    await vi.waitFor(() => {
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)
    })
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

    await vi.advanceTimersByTimeAsync(59 * 60 * 1000)
    expect(autoUpdaterMock.checkForUpdates).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(60 * 1000)
    await vi.waitFor(() => {
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)
    })
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

    await vi.waitFor(() => {
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)
    })
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

    await vi.waitFor(() => {
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)
    })

    await vi.advanceTimersByTimeAsync(59 * 60 * 1000)
    expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(60 * 1000)
    await vi.waitFor(() => {
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(2)
    })
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

    await vi.waitFor(() => {
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)
    })
    await vi.advanceTimersByTimeAsync(0)

    expect(setLastUpdateCheckAt).toHaveBeenCalledTimes(1)
    expect(sendMock).toHaveBeenCalledWith('updater:status', {
      state: 'available',
      version: '1.0.61',
      changelog: null
    })

    await vi.advanceTimersByTimeAsync(23 * 60 * 60 * 1000 + 59 * 60 * 1000)
    expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(60 * 1000)
    await vi.waitFor(() => {
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(2)
    })
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

    await vi.waitFor(() => {
      const statusCalls = sendMock.mock.calls
        .filter(([channel]) => channel === 'updater:status')
        .map(([, status]) => status)

      expect(statusCalls).toContainEqual({ state: 'checking', userInitiated: true })
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(2)
    })

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

    await vi.waitFor(() => {
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)
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

  it('clears pending nudge campaign when a silent follow-up check settles not-available', async () => {
    vi.useFakeTimers()
    const sendMock = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }
    let pendingNudgeId: string | null = null
    const setPendingUpdateNudgeId = vi.fn((id: string | null) => {
      pendingNudgeId = id
    })
    const setDismissedUpdateNudgeId = vi.fn()

    fetchNudgeMock.mockResolvedValue({ id: 'campaign-1', minVersion: '1.0.0' })
    shouldApplyNudgeMock.mockReturnValue(true)
    fetchNewerReleaseTagsMock.mockResolvedValue({ tags: [], state: 'no-newer' })
    autoUpdaterMock.checkForUpdates.mockResolvedValue(undefined)

    const { setupAutoUpdater } = await import('./updater')

    setupAutoUpdater(mainWindow as never, {
      getLastUpdateCheckAt: () => Date.now(),
      setPendingUpdateNudgeId,
      getPendingUpdateNudgeId: () => pendingNudgeId,
      getDismissedUpdateNudgeId: () => null,
      setDismissedUpdateNudgeId
    })

    await vi.waitFor(() => {
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)
    })
    expect(setPendingUpdateNudgeId).toHaveBeenCalledWith('campaign-1')

    await vi.advanceTimersByTimeAsync(1000)

    expect(sendMock).toHaveBeenCalledWith('updater:status', { state: 'not-available' })
    expect(setPendingUpdateNudgeId).toHaveBeenCalledWith(null)
    expect(setDismissedUpdateNudgeId).toHaveBeenCalledWith('campaign-1')
    expect(pendingNudgeId).toBe(null)
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

  it('does not preserve a pending nudge for ordinary manifest transition errors', async () => {
    const sendMock = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }
    const setPendingUpdateNudgeId = vi.fn()
    const setDismissedUpdateNudgeId = vi.fn()
    const missingManifest = new Error(
      'Cannot find channel "latest-mac.yml" update info: HttpError: 404'
    )

    fetchNudgeMock.mockResolvedValue({ id: 'campaign-1', minVersion: '1.0.0' })
    shouldApplyNudgeMock.mockReturnValue(true)
    autoUpdaterMock.checkForUpdates.mockImplementation(() => {
      autoUpdaterMock.emit('checking-for-update')
      return Promise.reject(missingManifest)
    })

    const { setupAutoUpdater } = await import('./updater')

    setupAutoUpdater(mainWindow as never, {
      getLastUpdateCheckAt: () => Date.now(),
      setPendingUpdateNudgeId,
      getPendingUpdateNudgeId: () => null,
      getDismissedUpdateNudgeId: () => null,
      setDismissedUpdateNudgeId
    })

    await vi.waitFor(() => {
      expect(setPendingUpdateNudgeId).toHaveBeenCalledWith(null)
    })

    expect(setDismissedUpdateNudgeId).toHaveBeenCalledWith('campaign-1')
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

  // Why: the Windows auto-updater must keep electron-updater's built-in
  // Authenticode verification, which checks the downloaded installer against
  // the SignPath Foundation publisherName that electron-builder embeds in
  // app-update.yml. A no-op verifyUpdateCodeSignature override would silently
  // accept every installer, so setup must NOT install one. (The issue #631
  // stale-publisherName problem that once justified an override is resolved now
  // that SignPath builds embed the correct publisherName.)
  it('does not disable Windows Authenticode verification on win32', async () => {
    vi.stubGlobal('process', { ...process, platform: 'win32' })

    const { setupAutoUpdater } = await import('./updater')

    const sendMock = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }

    setupAutoUpdater(mainWindow as never)

    expect((autoUpdaterMock as Record<string, unknown>).verifyUpdateCodeSignature).toBeUndefined()
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
    fetchNewerReleaseTagsMock.mockResolvedValue(['v1.3.17-rc.2'])
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
      expect(fetchNewerReleaseTagsMock).toHaveBeenCalledWith('1.3.17-rc.1', 2, {
        includePrerelease: true
      })
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
    fetchNewerReleaseTagsMock.mockResolvedValue(['v1.3.19'])
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
    fetchNewerReleaseTagsMock.mockResolvedValue([])
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

  it('uses last-good concrete feed when a user-initiated check lands during publishing', async () => {
    appMock.getVersion.mockReturnValue('1.4.26')
    fetchNewerReleaseTagsMock.mockResolvedValue({
      tags: [],
      state: 'not-ready',
      lastGoodTag: 'v1.4.26'
    })
    autoUpdaterMock.checkForUpdates.mockImplementation(() => {
      autoUpdaterMock.emit('checking-for-update')
      queueMicrotask(() => {
        autoUpdaterMock.emit('update-not-available')
      })
      return Promise.resolve(undefined)
    })

    const sendMock = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }

    const { setupAutoUpdater, checkForUpdatesFromMenu } = await import('./updater')

    setupAutoUpdater(mainWindow as never, { getLastUpdateCheckAt: () => Date.now() })
    const feedCallsBeforeCheck = autoUpdaterMock.setFeedURL.mock.calls.length

    checkForUpdatesFromMenu()

    await vi.waitFor(() => {
      const statuses = sendMock.mock.calls
        .filter(([channel]) => channel === 'updater:status')
        .map(([, status]) => status)
      expect(statuses).toContainEqual({ state: 'checking', userInitiated: true })
      expect(statuses).toContainEqual({ state: 'not-available', userInitiated: true })
    })
    expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)
    expect(autoUpdaterMock.setFeedURL).toHaveBeenLastCalledWith({
      provider: 'generic',
      url: 'https://github.com/stablyai/orca/releases/download/v1.4.26'
    })
    expect(autoUpdaterMock.setFeedURL).not.toHaveBeenCalledWith({
      provider: 'generic',
      url: 'https://github.com/stablyai/orca/releases/download/v1.4.27'
    })
    expect(autoUpdaterMock.setFeedURL.mock.calls.slice(feedCallsBeforeCheck)).not.toContainEqual([
      {
        provider: 'generic',
        url: 'https://github.com/stablyai/orca/releases/latest/download'
      }
    ])
    expect(sendMock).not.toHaveBeenCalledWith(
      'updater:status',
      expect.objectContaining({ state: 'error' })
    )
  })

  it('can offer an older fully published update while the newest release is publishing', async () => {
    appMock.getVersion.mockReturnValue('1.4.25')
    fetchNewerReleaseTagsMock.mockResolvedValue({
      tags: [],
      state: 'not-ready',
      lastGoodTag: 'v1.4.26'
    })
    autoUpdaterMock.checkForUpdates.mockImplementation(() => {
      autoUpdaterMock.emit('checking-for-update')
      queueMicrotask(() => {
        autoUpdaterMock.emit('update-available', { version: '1.4.26' })
      })
      return Promise.resolve(undefined)
    })

    const sendMock = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }

    const { setupAutoUpdater, checkForUpdatesFromMenu } = await import('./updater')

    setupAutoUpdater(mainWindow as never, { getLastUpdateCheckAt: () => Date.now() })

    checkForUpdatesFromMenu()

    await vi.waitFor(() => {
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)
      expect(sendMock).toHaveBeenCalledWith('updater:status', {
        state: 'available',
        version: '1.4.26',
        changelog: null
      })
    })
    expect(autoUpdaterMock.setFeedURL).toHaveBeenLastCalledWith({
      provider: 'generic',
      url: 'https://github.com/stablyai/orca/releases/download/v1.4.26'
    })
  })

  it('keeps background publishing-window fallback on the short retry cadence', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-24T21:40:00Z'))
    appMock.getVersion.mockReturnValue('1.4.26')
    fetchNewerReleaseTagsMock
      .mockResolvedValueOnce({
        tags: [],
        state: 'not-ready',
        lastGoodTag: 'v1.4.26'
      })
      .mockResolvedValueOnce(['v1.4.27'])
    autoUpdaterMock.checkForUpdates.mockImplementation(() => {
      autoUpdaterMock.emit('checking-for-update')
      return new Promise(() => {})
    })
    const setLastUpdateCheckAt = vi.fn()
    const sendMock = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }

    const { setupAutoUpdater } = await import('./updater')

    setupAutoUpdater(mainWindow as never, {
      getLastUpdateCheckAt: () => null,
      setLastUpdateCheckAt
    })

    await vi.waitFor(() => {
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)
    })
    expect(autoUpdaterMock.setFeedURL).toHaveBeenLastCalledWith({
      provider: 'generic',
      url: 'https://github.com/stablyai/orca/releases/download/v1.4.26'
    })
    expect(setLastUpdateCheckAt).not.toHaveBeenCalled()

    autoUpdaterMock.emit('update-not-available')

    await vi.waitFor(() => {
      expect(sendMock).toHaveBeenCalledWith('updater:status', { state: 'not-available' })
    })
    expect(setLastUpdateCheckAt).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(59 * 60 * 1000)
    expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(60 * 1000)
    await vi.waitFor(() => {
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(2)
    })
    expect(autoUpdaterMock.setFeedURL).toHaveBeenLastCalledWith({
      provider: 'generic',
      url: 'https://github.com/stablyai/orca/releases/download/v1.4.27'
    })
  })

  it('keeps silent publishing-window fallback on the short retry cadence', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-24T21:40:00Z'))
    appMock.getVersion.mockReturnValue('1.4.26')
    fetchNewerReleaseTagsMock
      .mockResolvedValueOnce({
        tags: [],
        state: 'not-ready',
        lastGoodTag: 'v1.4.26'
      })
      .mockResolvedValueOnce(['v1.4.27'])
    autoUpdaterMock.checkForUpdates.mockImplementation(() => {
      autoUpdaterMock.emit('checking-for-update')
      return Promise.resolve(undefined)
    })
    const setLastUpdateCheckAt = vi.fn()
    const sendMock = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }

    const { setupAutoUpdater } = await import('./updater')

    setupAutoUpdater(mainWindow as never, {
      getLastUpdateCheckAt: () => null,
      setLastUpdateCheckAt
    })

    await vi.waitFor(() => {
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)
    })
    await vi.advanceTimersByTimeAsync(1000)

    expect(sendMock).toHaveBeenCalledWith(
      'updater:status',
      expect.objectContaining({ state: 'not-available' })
    )
    expect(setLastUpdateCheckAt).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(59 * 60 * 1000)
    expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(60 * 1000)
    await vi.waitFor(() => {
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(2)
    })
    expect(autoUpdaterMock.setFeedURL).toHaveBeenLastCalledWith({
      provider: 'generic',
      url: 'https://github.com/stablyai/orca/releases/download/v1.4.27'
    })
  })

  it('keeps background checks retryable while newer release assets are still publishing', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-24T21:40:00Z'))
    appMock.getVersion.mockReturnValue('1.4.26')
    fetchNewerReleaseTagsMock
      .mockResolvedValueOnce({ tags: [], state: 'not-ready' })
      .mockResolvedValueOnce(['v1.4.27'])
    autoUpdaterMock.checkForUpdates.mockResolvedValue(undefined)
    const setLastUpdateCheckAt = vi.fn()
    const sendMock = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }

    const { setupAutoUpdater } = await import('./updater')

    setupAutoUpdater(mainWindow as never, {
      getLastUpdateCheckAt: () => null,
      setLastUpdateCheckAt
    })

    await vi.waitFor(() => {
      expect(fetchNewerReleaseTagsMock).toHaveBeenCalledTimes(1)
    })
    expect(autoUpdaterMock.checkForUpdates).not.toHaveBeenCalled()
    expect(setLastUpdateCheckAt).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(60 * 60 * 1000)

    await vi.waitFor(() => {
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)
    })
    expect(autoUpdaterMock.setFeedURL).toHaveBeenLastCalledWith({
      provider: 'generic',
      url: 'https://github.com/stablyai/orca/releases/download/v1.4.27'
    })
  })

  it('keeps a nudge campaign pending when release assets are still publishing', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-24T21:40:00Z'))
    appMock.getVersion.mockReturnValue('1.4.26')
    fetchNudgeMock.mockResolvedValueOnce({ id: 'campaign-1', minVersion: '1.0.0' })
    fetchNudgeMock.mockResolvedValue(null)
    shouldApplyNudgeMock.mockReturnValue(true)
    fetchNewerReleaseTagsMock
      .mockResolvedValueOnce({ tags: [], state: 'not-ready' })
      .mockResolvedValueOnce(['v1.4.27'])
    autoUpdaterMock.checkForUpdates.mockImplementation(() => {
      autoUpdaterMock.emit('checking-for-update')
      return Promise.resolve(undefined)
    })
    let pendingNudgeId: string | null = null
    const setPendingUpdateNudgeId = vi.fn((id: string | null) => {
      pendingNudgeId = id
    })
    const setDismissedUpdateNudgeId = vi.fn()
    const sendMock = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }

    const { setupAutoUpdater } = await import('./updater')

    setupAutoUpdater(mainWindow as never, {
      getLastUpdateCheckAt: () => Date.now(),
      getPendingUpdateNudgeId: () => pendingNudgeId,
      getDismissedUpdateNudgeId: () => null,
      setPendingUpdateNudgeId,
      setDismissedUpdateNudgeId
    })

    await vi.waitFor(() => {
      expect(fetchNewerReleaseTagsMock).toHaveBeenCalledTimes(1)
    })
    expect(setPendingUpdateNudgeId).toHaveBeenCalledWith('campaign-1')
    expect(setPendingUpdateNudgeId).not.toHaveBeenCalledWith(null)
    expect(setDismissedUpdateNudgeId).not.toHaveBeenCalled()
    expect(pendingNudgeId).toBe('campaign-1')

    await vi.advanceTimersByTimeAsync(60 * 60 * 1000)

    await vi.waitFor(() => {
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)
    })
    autoUpdaterMock.emit('update-available', { version: '1.4.27' })
    await vi.advanceTimersByTimeAsync(0)

    expect(sendMock).toHaveBeenCalledWith('updater:status', {
      state: 'available',
      version: '1.4.27',
      changelog: null,
      activeNudgeId: 'campaign-1'
    })
    expect(setDismissedUpdateNudgeId).not.toHaveBeenCalled()
  })

  it('does not dismiss a nudge when last-good fallback is current during publishing', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-24T21:40:00Z'))
    appMock.getVersion.mockReturnValue('1.4.26')
    fetchNudgeMock.mockResolvedValue({ id: 'campaign-1', minVersion: '1.0.0' })
    shouldApplyNudgeMock.mockReturnValue(true)
    fetchNewerReleaseTagsMock
      .mockResolvedValueOnce({
        tags: [],
        state: 'not-ready',
        lastGoodTag: 'v1.4.26'
      })
      .mockResolvedValueOnce(['v1.4.27'])
    autoUpdaterMock.checkForUpdates.mockImplementation(() => {
      autoUpdaterMock.emit('checking-for-update')
      if (autoUpdaterMock.checkForUpdates.mock.calls.length === 1) {
        queueMicrotask(() => {
          autoUpdaterMock.emit('update-not-available')
        })
      }
      return Promise.resolve(undefined)
    })
    let pendingNudgeId: string | null = null
    const setPendingUpdateNudgeId = vi.fn((id: string | null) => {
      pendingNudgeId = id
    })
    const setDismissedUpdateNudgeId = vi.fn()
    const sendMock = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }

    const { setupAutoUpdater } = await import('./updater')

    setupAutoUpdater(mainWindow as never, {
      getLastUpdateCheckAt: () => Date.now(),
      getPendingUpdateNudgeId: () => pendingNudgeId,
      getDismissedUpdateNudgeId: () => null,
      setPendingUpdateNudgeId,
      setDismissedUpdateNudgeId
    })

    await vi.waitFor(() => {
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)
      expect(sendMock).toHaveBeenCalledWith('updater:status', { state: 'not-available' })
    })

    expect(setPendingUpdateNudgeId).toHaveBeenCalledWith('campaign-1')
    expect(setPendingUpdateNudgeId).not.toHaveBeenCalledWith(null)
    expect(setDismissedUpdateNudgeId).not.toHaveBeenCalled()
    expect(pendingNudgeId).toBe('campaign-1')

    await vi.advanceTimersByTimeAsync(60 * 60 * 1000)

    await vi.waitFor(() => {
      expect(autoUpdaterMock.checkForUpdates.mock.calls.length).toBeGreaterThanOrEqual(2)
    })
    autoUpdaterMock.emit('update-available', { version: '1.4.27' })
    await vi.advanceTimersByTimeAsync(0)

    expect(sendMock).toHaveBeenCalledWith('updater:status', {
      state: 'available',
      version: '1.4.27',
      changelog: null,
      activeNudgeId: 'campaign-1'
    })
  })

  it('does not attach nudge dismissal to an older last-good available update', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-24T21:40:00Z'))
    appMock.getVersion.mockReturnValue('1.4.25')
    fetchNudgeMock.mockResolvedValueOnce({ id: 'campaign-1', minVersion: '1.0.0' })
    fetchNudgeMock.mockResolvedValue(null)
    shouldApplyNudgeMock.mockReturnValue(true)
    fetchNewerReleaseTagsMock
      .mockResolvedValueOnce({
        tags: [],
        state: 'not-ready',
        lastGoodTag: 'v1.4.26'
      })
      .mockResolvedValueOnce(['v1.4.27'])
    autoUpdaterMock.checkForUpdates.mockImplementation(() => {
      autoUpdaterMock.emit('checking-for-update')
      if (autoUpdaterMock.checkForUpdates.mock.calls.length === 1) {
        queueMicrotask(() => {
          autoUpdaterMock.emit('update-available', { version: '1.4.26' })
        })
      }
      return Promise.resolve(undefined)
    })
    let pendingNudgeId: string | null = null
    const setPendingUpdateNudgeId = vi.fn((id: string | null) => {
      pendingNudgeId = id
    })
    const setDismissedUpdateNudgeId = vi.fn()
    const sendMock = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }

    const { setupAutoUpdater, dismissNudge } = await import('./updater')

    setupAutoUpdater(mainWindow as never, {
      getLastUpdateCheckAt: () => Date.now(),
      getPendingUpdateNudgeId: () => pendingNudgeId,
      getDismissedUpdateNudgeId: () => null,
      setPendingUpdateNudgeId,
      setDismissedUpdateNudgeId
    })

    await vi.waitFor(() => {
      expect(sendMock).toHaveBeenCalledWith('updater:status', {
        state: 'available',
        version: '1.4.26',
        changelog: null
      })
    })
    const statuses = sendMock.mock.calls
      .filter(([channel]) => channel === 'updater:status')
      .map(([, status]) => status)
    const lastGoodStatus = statuses.find(
      (status) => status.state === 'available' && status.version === '1.4.26'
    )
    if (lastGoodStatus && 'activeNudgeId' in lastGoodStatus) {
      dismissNudge()
    }

    expect(setPendingUpdateNudgeId).toHaveBeenCalledWith('campaign-1')
    expect(setPendingUpdateNudgeId).not.toHaveBeenCalledWith(null)
    expect(setDismissedUpdateNudgeId).not.toHaveBeenCalled()
    expect(pendingNudgeId).toBe('campaign-1')

    await vi.advanceTimersByTimeAsync(60 * 60 * 1000)

    await vi.waitFor(() => {
      expect(autoUpdaterMock.checkForUpdates.mock.calls.length).toBeGreaterThanOrEqual(2)
    })
    autoUpdaterMock.emit('update-available', { version: '1.4.27' })
    await vi.advanceTimersByTimeAsync(0)

    expect(sendMock).toHaveBeenCalledWith('updater:status', {
      state: 'available',
      version: '1.4.27',
      changelog: null,
      activeNudgeId: 'campaign-1'
    })
  })

  it('retries a prerelease check once against the previous feed tag when the manifest is missing', async () => {
    appMock.getVersion.mockReturnValue('1.3.51-rc.6')
    fetchNewerReleaseTagsMock.mockResolvedValue(['v1.3.51-rc.7', 'v1.3.51-rc.6'])

    const missingManifest = new Error(
      'Cannot find channel "latest-mac.yml" update info: HttpError: 404'
    )
    autoUpdaterMock.checkForUpdates.mockImplementation(() => {
      autoUpdaterMock.emit('checking-for-update')
      if (autoUpdaterMock.checkForUpdates.mock.calls.length === 1) {
        queueMicrotask(() => {
          autoUpdaterMock.emit('error', missingManifest)
        })
        return Promise.reject(missingManifest)
      }
      queueMicrotask(() => {
        autoUpdaterMock.emit('update-not-available')
      })
      return Promise.resolve(undefined)
    })

    const sendMock = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }
    const { setupAutoUpdater, checkForUpdatesFromMenu } = await import('./updater')

    setupAutoUpdater(mainWindow as never, { getLastUpdateCheckAt: () => Date.now() })
    checkForUpdatesFromMenu()

    await vi.waitFor(() => {
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(2)
      expect(autoUpdaterMock.setFeedURL).toHaveBeenCalledWith({
        provider: 'generic',
        url: 'https://github.com/stablyai/orca/releases/download/v1.3.51-rc.7'
      })
      expect(autoUpdaterMock.setFeedURL).toHaveBeenLastCalledWith({
        provider: 'generic',
        url: 'https://github.com/stablyai/orca/releases/download/v1.3.51-rc.6'
      })
    })

    const statuses = sendMock.mock.calls
      .filter(([channel]) => channel === 'updater:status')
      .map(([, status]) => status)
    expect(statuses).toContainEqual({ state: 'not-available', userInitiated: true })
    expect(statuses).not.toContainEqual(expect.objectContaining({ state: 'error' }))
  })

  it('surfaces a promise-only prerelease fallback failure after the primary error event', async () => {
    appMock.getVersion.mockReturnValue('1.3.51-rc.6')
    fetchNewerReleaseTagsMock.mockResolvedValue(['v1.3.51-rc.7', 'v1.3.51-rc.6'])

    const missingManifest = new Error(
      'Cannot find channel "latest-mac.yml" update info: HttpError: 404'
    )
    autoUpdaterMock.checkForUpdates.mockImplementation(() => {
      autoUpdaterMock.emit('checking-for-update')
      if (autoUpdaterMock.checkForUpdates.mock.calls.length === 1) {
        queueMicrotask(() => {
          autoUpdaterMock.emit('error', missingManifest)
        })
        return new Promise(() => {})
      }
      return Promise.reject(missingManifest)
    })

    const sendMock = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }
    const { setupAutoUpdater, checkForUpdatesFromMenu } = await import('./updater')

    setupAutoUpdater(mainWindow as never, { getLastUpdateCheckAt: () => Date.now() })
    checkForUpdatesFromMenu()

    await vi.waitFor(() => {
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(2)
      const statuses = sendMock.mock.calls
        .filter(([channel]) => channel === 'updater:status')
        .map(([, status]) => status)
      expect(statuses).toContainEqual({
        state: 'error',
        message: "Couldn't reach the update server. Try again in a few minutes.",
        userInitiated: true
      })
    })
  })

  it('allows the short background retry to launch after a promise-only prerelease fallback failure', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-03T12:00:00Z'))
    appMock.getVersion.mockReturnValue('1.3.51-rc.6')
    fetchNewerReleaseTagsMock.mockResolvedValue(['v1.3.51-rc.7', 'v1.3.51-rc.6'])

    const missingManifest = new Error(
      'Cannot find channel "latest-mac.yml" update info: HttpError: 404'
    )
    autoUpdaterMock.checkForUpdates.mockImplementation(() => {
      const callCount = autoUpdaterMock.checkForUpdates.mock.calls.length
      if (callCount === 1) {
        autoUpdaterMock.emit('checking-for-update')
        queueMicrotask(() => {
          autoUpdaterMock.emit('error', missingManifest)
        })
        return new Promise(() => {})
      }
      if (callCount === 2) {
        return Promise.reject(missingManifest)
      }
      return new Promise(() => {})
    })

    const sendMock = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }
    const { setupAutoUpdater } = await import('./updater')

    setupAutoUpdater(mainWindow as never, { getLastUpdateCheckAt: () => null })

    await vi.waitFor(() => {
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(2)
      const statuses = sendMock.mock.calls
        .filter(([channel]) => channel === 'updater:status')
        .map(([, status]) => status)
      expect(statuses).toContainEqual({ state: 'idle' })
    })

    await vi.advanceTimersByTimeAsync(59 * 60 * 1000)
    expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(2)

    await vi.advanceTimersByTimeAsync(60 * 1000)
    expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(3)
  })

  it('does not let user-initiated promise-only fallback failures taint the next background check', async () => {
    let lastUpdateCheckAt = Date.now()
    appMock.getVersion.mockReturnValue('1.3.51-rc.6')
    fetchNewerReleaseTagsMock.mockResolvedValue(['v1.3.51-rc.7', 'v1.3.51-rc.6'])

    const missingManifest = new Error(
      'Cannot find channel "latest-mac.yml" update info: HttpError: 404'
    )
    autoUpdaterMock.checkForUpdates.mockImplementation(() => {
      const callCount = autoUpdaterMock.checkForUpdates.mock.calls.length
      if (callCount === 1) {
        autoUpdaterMock.emit('checking-for-update')
        queueMicrotask(() => {
          autoUpdaterMock.emit('error', missingManifest)
        })
        return new Promise(() => {})
      }
      if (callCount === 2) {
        return Promise.reject(missingManifest)
      }
      autoUpdaterMock.emit('checking-for-update')
      queueMicrotask(() => {
        autoUpdaterMock.emit('update-not-available')
      })
      return Promise.resolve(undefined)
    })

    const sendMock = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }
    const { setupAutoUpdater, checkForUpdatesFromMenu } = await import('./updater')

    setupAutoUpdater(mainWindow as never, { getLastUpdateCheckAt: () => lastUpdateCheckAt })
    checkForUpdatesFromMenu()

    await vi.waitFor(() => {
      const statuses = sendMock.mock.calls
        .filter(([channel]) => channel === 'updater:status')
        .map(([, status]) => status)
      expect(statuses).toContainEqual({
        state: 'error',
        message: "Couldn't reach the update server. Try again in a few minutes.",
        userInitiated: true
      })
    })

    sendMock.mockClear()
    lastUpdateCheckAt = Date.now() - 25 * 60 * 60 * 1000
    appMock.emit('browser-window-focus')

    await vi.waitFor(() => {
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(3)
      const statuses = sendMock.mock.calls
        .filter(([channel]) => channel === 'updater:status')
        .map(([, status]) => status)
      expect(statuses).toContainEqual({ state: 'not-available' })
      expect(statuses).not.toContainEqual({ state: 'checking', userInitiated: true })
      expect(statuses).not.toContainEqual({ state: 'not-available', userInitiated: true })
    })
  })

  it('preserves user-initiated state for delayed prerelease fallback not-available', async () => {
    vi.useFakeTimers()
    appMock.getVersion.mockReturnValue('1.3.51-rc.6')
    fetchNewerReleaseTagsMock.mockResolvedValue(['v1.3.51-rc.7', 'v1.3.51-rc.6'])

    const missingManifest = new Error(
      'Cannot find channel "latest-mac.yml" update info: HttpError: 404'
    )
    autoUpdaterMock.checkForUpdates.mockImplementation(() => {
      const callCount = autoUpdaterMock.checkForUpdates.mock.calls.length
      if (callCount === 1) {
        autoUpdaterMock.emit('checking-for-update')
        queueMicrotask(() => {
          autoUpdaterMock.emit('error', missingManifest)
        })
        return Promise.reject(missingManifest)
      }
      setTimeout(() => {
        autoUpdaterMock.emit('update-not-available')
      }, 10)
      return Promise.resolve(undefined)
    })

    const sendMock = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }
    const { setupAutoUpdater, checkForUpdatesFromMenu } = await import('./updater')

    setupAutoUpdater(mainWindow as never, { getLastUpdateCheckAt: () => Date.now() })
    checkForUpdatesFromMenu()

    await vi.waitFor(() => {
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(2)
    })
    await vi.advanceTimersByTimeAsync(10)

    const statuses = sendMock.mock.calls
      .filter(([channel]) => channel === 'updater:status')
      .map(([, status]) => status)
    expect(statuses).toContainEqual({ state: 'not-available', userInitiated: true })
  })

  it('ignores a delayed primary error after a promise-launched prerelease fallback', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-03T12:00:00Z'))
    appMock.getVersion.mockReturnValue('1.3.51-rc.6')
    fetchNewerReleaseTagsMock.mockResolvedValue(['v1.3.51-rc.7', 'v1.3.51-rc.6'])

    const missingManifest = new Error(
      'Cannot find channel "latest-mac.yml" update info: HttpError: 404'
    )
    autoUpdaterMock.checkForUpdates.mockImplementation(() => {
      const callCount = autoUpdaterMock.checkForUpdates.mock.calls.length
      autoUpdaterMock.emit('checking-for-update')
      if (callCount === 1) {
        setTimeout(() => {
          autoUpdaterMock.emit('error', missingManifest)
        }, 10)
        return Promise.reject(missingManifest)
      }
      if (callCount === 2) {
        setTimeout(() => {
          autoUpdaterMock.emit('update-not-available')
        }, 20)
        return Promise.resolve(undefined)
      }
      return new Promise(() => {})
    })

    const sendMock = vi.fn()
    const setLastUpdateCheckAt = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }
    const { setupAutoUpdater } = await import('./updater')

    setupAutoUpdater(mainWindow as never, {
      getLastUpdateCheckAt: () => null,
      setLastUpdateCheckAt
    })

    await vi.waitFor(() => {
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(2)
    })
    await vi.advanceTimersByTimeAsync(30)

    const statuses = sendMock.mock.calls
      .filter(([channel]) => channel === 'updater:status')
      .map(([, status]) => status)
    expect(statuses).toContainEqual({ state: 'not-available' })
    expect(statuses).not.toContainEqual(expect.objectContaining({ state: 'error' }))
    expect(setLastUpdateCheckAt).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(59 * 60 * 1000)
    expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(2)

    await vi.advanceTimersByTimeAsync(60 * 1000)
    expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(3)
  })

  it('handles an event-only fallback error after a promise-only primary failure', async () => {
    appMock.getVersion.mockReturnValue('1.3.51-rc.6')
    fetchNewerReleaseTagsMock.mockResolvedValue(['v1.3.51-rc.7', 'v1.3.51-rc.6'])

    const missingManifestMessage =
      'Cannot find channel "latest-mac.yml" update info: HttpError: 404'
    const primaryMissingManifest = new Error(missingManifestMessage)
    const fallbackMissingManifest = new Error(missingManifestMessage)
    autoUpdaterMock.checkForUpdates.mockImplementation(() => {
      const callCount = autoUpdaterMock.checkForUpdates.mock.calls.length
      autoUpdaterMock.emit('checking-for-update')
      if (callCount === 1) {
        return Promise.reject(primaryMissingManifest)
      }
      queueMicrotask(() => {
        autoUpdaterMock.emit('error', fallbackMissingManifest)
      })
      return new Promise(() => {})
    })

    const sendMock = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }
    const { setupAutoUpdater, checkForUpdatesFromMenu } = await import('./updater')

    setupAutoUpdater(mainWindow as never, { getLastUpdateCheckAt: () => Date.now() })
    checkForUpdatesFromMenu()

    await vi.waitFor(() => {
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(2)
      const statuses = sendMock.mock.calls
        .filter(([channel]) => channel === 'updater:status')
        .map(([, status]) => status)
      expect(statuses.at(-1)).toEqual({
        state: 'error',
        message: "Couldn't reach the update server. Try again in a few minutes.",
        userInitiated: true
      })
    })
  })

  it('suppresses a delayed background fallback error after the fallback promise handled it', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-03T12:00:00Z'))
    appMock.getVersion.mockReturnValue('1.3.51-rc.6')
    fetchNewerReleaseTagsMock.mockResolvedValue(['v1.3.51-rc.7', 'v1.3.51-rc.6'])

    const missingManifest = new Error(
      'Cannot find channel "latest-mac.yml" update info: HttpError: 404'
    )
    autoUpdaterMock.checkForUpdates.mockImplementation(() => {
      const callCount = autoUpdaterMock.checkForUpdates.mock.calls.length
      autoUpdaterMock.emit('checking-for-update')
      if (callCount === 1) {
        queueMicrotask(() => {
          autoUpdaterMock.emit('error', missingManifest)
        })
        return new Promise(() => {})
      }
      if (callCount === 2) {
        setTimeout(() => {
          autoUpdaterMock.emit('error', missingManifest)
        }, 10)
        return Promise.reject(missingManifest)
      }
      return new Promise(() => {})
    })

    const sendMock = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }
    const { setupAutoUpdater } = await import('./updater')

    setupAutoUpdater(mainWindow as never, { getLastUpdateCheckAt: () => null })

    await vi.waitFor(() => {
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(2)
      const statuses = sendMock.mock.calls
        .filter(([channel]) => channel === 'updater:status')
        .map(([, status]) => status)
      expect(statuses).toContainEqual({ state: 'idle' })
    })

    sendMock.mockClear()
    await vi.advanceTimersByTimeAsync(10)

    const statusesAfterLateError = sendMock.mock.calls
      .filter(([channel]) => channel === 'updater:status')
      .map(([, status]) => status)
    expect(statusesAfterLateError).not.toContainEqual(
      expect.objectContaining({ state: 'error', message: missingManifest.message })
    )

    await vi.advanceTimersByTimeAsync(59 * 60 * 1000)
    expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(2)

    await vi.advanceTimersByTimeAsync(60 * 1000)
    expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(3)
  })

  it('suppresses a delayed user fallback error after the fallback promise handled it', async () => {
    vi.useFakeTimers()
    appMock.getVersion.mockReturnValue('1.3.51-rc.6')
    fetchNewerReleaseTagsMock.mockResolvedValue(['v1.3.51-rc.7', 'v1.3.51-rc.6'])

    const missingManifest = new Error(
      'Cannot find channel "latest-mac.yml" update info: HttpError: 404'
    )
    autoUpdaterMock.checkForUpdates.mockImplementation(() => {
      const callCount = autoUpdaterMock.checkForUpdates.mock.calls.length
      autoUpdaterMock.emit('checking-for-update')
      if (callCount === 1) {
        queueMicrotask(() => {
          autoUpdaterMock.emit('error', missingManifest)
        })
        return new Promise(() => {})
      }
      setTimeout(() => {
        autoUpdaterMock.emit('error', missingManifest)
      }, 10)
      return Promise.reject(missingManifest)
    })

    const sendMock = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }
    const { setupAutoUpdater, checkForUpdatesFromMenu } = await import('./updater')

    setupAutoUpdater(mainWindow as never, { getLastUpdateCheckAt: () => Date.now() })
    checkForUpdatesFromMenu()

    await vi.waitFor(() => {
      const statuses = sendMock.mock.calls
        .filter(([channel]) => channel === 'updater:status')
        .map(([, status]) => status)
      expect(statuses).toContainEqual({
        state: 'error',
        message: "Couldn't reach the update server. Try again in a few minutes.",
        userInitiated: true
      })
    })

    sendMock.mockClear()
    await vi.advanceTimersByTimeAsync(10)

    const statusesAfterLateError = sendMock.mock.calls
      .filter(([channel]) => channel === 'updater:status')
      .map(([, status]) => status)
    expect(statusesAfterLateError).not.toContainEqual(
      expect.objectContaining({ state: 'error', message: missingManifest.message })
    )
  })

  it('keeps background prerelease fallback not-available on the short retry cadence', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-03T12:00:00Z'))
    appMock.getVersion.mockReturnValue('1.3.51-rc.6')
    fetchNewerReleaseTagsMock.mockResolvedValue(['v1.3.51-rc.7', 'v1.3.51-rc.6'])

    const missingManifest = new Error(
      'Cannot find channel "latest-mac.yml" update info: HttpError: 404'
    )
    autoUpdaterMock.checkForUpdates.mockImplementation(() => {
      autoUpdaterMock.emit('checking-for-update')
      if (autoUpdaterMock.checkForUpdates.mock.calls.length === 1) {
        queueMicrotask(() => {
          autoUpdaterMock.emit('error', missingManifest)
        })
        return new Promise(() => {})
      }
      if (autoUpdaterMock.checkForUpdates.mock.calls.length === 2) {
        queueMicrotask(() => {
          autoUpdaterMock.emit('update-not-available')
        })
        return Promise.resolve(undefined)
      }
      return new Promise(() => {})
    })

    const sendMock = vi.fn()
    const setLastUpdateCheckAt = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }
    const { setupAutoUpdater } = await import('./updater')

    setupAutoUpdater(mainWindow as never, {
      getLastUpdateCheckAt: () => null,
      setLastUpdateCheckAt
    })

    await vi.waitFor(() => {
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(2)
      const statuses = sendMock.mock.calls
        .filter(([channel]) => channel === 'updater:status')
        .map(([, status]) => status)
      expect(statuses).toContainEqual({ state: 'not-available' })
    })

    expect(setLastUpdateCheckAt).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(59 * 60 * 1000)
    expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(2)

    await vi.advanceTimersByTimeAsync(60 * 1000)
    expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(3)
  })

  it('keeps user prerelease fallback not-available on the short retry cadence', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-03T12:00:00Z'))
    appMock.getVersion.mockReturnValue('1.3.51-rc.6')
    fetchNewerReleaseTagsMock.mockResolvedValue(['v1.3.51-rc.7', 'v1.3.51-rc.6'])

    const missingManifest = new Error(
      'Cannot find channel "latest-mac.yml" update info: HttpError: 404'
    )
    autoUpdaterMock.checkForUpdates.mockImplementation(() => {
      const callCount = autoUpdaterMock.checkForUpdates.mock.calls.length
      autoUpdaterMock.emit('checking-for-update')
      if (callCount === 1) {
        queueMicrotask(() => {
          autoUpdaterMock.emit('error', missingManifest)
        })
        return new Promise(() => {})
      }
      if (callCount === 2) {
        queueMicrotask(() => {
          autoUpdaterMock.emit('update-not-available')
        })
        return Promise.resolve(undefined)
      }
      return new Promise(() => {})
    })

    const sendMock = vi.fn()
    const setLastUpdateCheckAt = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }
    const { setupAutoUpdater, checkForUpdatesFromMenu } = await import('./updater')

    setupAutoUpdater(mainWindow as never, {
      getLastUpdateCheckAt: () => Date.now(),
      setLastUpdateCheckAt
    })
    checkForUpdatesFromMenu()

    await vi.waitFor(() => {
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(2)
      const statuses = sendMock.mock.calls
        .filter(([channel]) => channel === 'updater:status')
        .map(([, status]) => status)
      expect(statuses).toContainEqual({ state: 'not-available', userInitiated: true })
    })

    expect(setLastUpdateCheckAt).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(59 * 60 * 1000)
    expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(2)

    await vi.advanceTimersByTimeAsync(60 * 1000)
    expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(3)
  })

  it('keeps user prerelease fallback available on the short retry cadence', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-03T12:00:00Z'))
    appMock.getVersion.mockReturnValue('1.3.51-rc.5')
    fetchNewerReleaseTagsMock.mockResolvedValue(['v1.3.51-rc.7', 'v1.3.51-rc.6'])

    const missingManifest = new Error(
      'Cannot find channel "latest-mac.yml" update info: HttpError: 404'
    )
    autoUpdaterMock.checkForUpdates.mockImplementation(() => {
      const callCount = autoUpdaterMock.checkForUpdates.mock.calls.length
      autoUpdaterMock.emit('checking-for-update')
      if (callCount === 1) {
        queueMicrotask(() => {
          autoUpdaterMock.emit('error', missingManifest)
        })
        return new Promise(() => {})
      }
      if (callCount === 2) {
        queueMicrotask(() => {
          autoUpdaterMock.emit('update-available', { version: '1.3.51-rc.6' })
        })
        return Promise.resolve(undefined)
      }
      return new Promise(() => {})
    })

    const sendMock = vi.fn()
    const setLastUpdateCheckAt = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }
    const { setupAutoUpdater, checkForUpdatesFromMenu } = await import('./updater')

    setupAutoUpdater(mainWindow as never, {
      getLastUpdateCheckAt: () => Date.now(),
      setLastUpdateCheckAt
    })
    checkForUpdatesFromMenu()

    await vi.waitFor(() => {
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(2)
      const statuses = sendMock.mock.calls
        .filter(([channel]) => channel === 'updater:status')
        .map(([, status]) => status)
      expect(statuses).toContainEqual({
        state: 'available',
        version: '1.3.51-rc.6',
        changelog: null
      })
    })

    expect(setLastUpdateCheckAt).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(59 * 60 * 1000)
    expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(2)

    await vi.advanceTimersByTimeAsync(60 * 1000)
    expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(3)
  })

  it('surfaces the failure when the bounded prerelease fallback also misses its manifest', async () => {
    appMock.getVersion.mockReturnValue('1.3.51-rc.6')
    fetchNewerReleaseTagsMock.mockResolvedValue(['v1.3.51-rc.7', 'v1.3.51-rc.6'])

    const missingManifest = new Error(
      'Cannot find channel "latest-mac.yml" update info: HttpError: 404'
    )
    autoUpdaterMock.checkForUpdates.mockImplementation(() => {
      autoUpdaterMock.emit('checking-for-update')
      queueMicrotask(() => {
        autoUpdaterMock.emit('error', missingManifest)
      })
      return Promise.reject(missingManifest)
    })

    const sendMock = vi.fn()
    const mainWindow = { webContents: { send: sendMock } }
    const { setupAutoUpdater, checkForUpdatesFromMenu } = await import('./updater')

    setupAutoUpdater(mainWindow as never, { getLastUpdateCheckAt: () => Date.now() })
    checkForUpdatesFromMenu()

    await vi.waitFor(() => {
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(2)
    })
    await vi.waitFor(() => {
      const statuses = sendMock.mock.calls
        .filter(([channel]) => channel === 'updater:status')
        .map(([, status]) => status)
      expect(statuses).toContainEqual({
        state: 'error',
        message: "Couldn't reach the update server. Try again in a few minutes.",
        userInitiated: true
      })
    })
  })

  // Why: /releases/latest/download is a moving redirect. If a new stable
  // release publishes between check and manual download, a relative ZIP URL
  // from the old manifest can resolve against the new release and 404.
  it('pins the generic feed to a concrete stable tag for a stable user', async () => {
    appMock.getVersion.mockReturnValue('1.3.17')
    fetchNewerReleaseTagsMock.mockResolvedValue(['v1.3.18'])
    autoUpdaterMock.checkForUpdates.mockResolvedValue(undefined)

    const { setupAutoUpdater, checkForUpdatesFromMenu } = await import('./updater')

    const mainWindow = { webContents: { send: vi.fn() } }
    setupAutoUpdater(mainWindow as never, { getLastUpdateCheckAt: () => Date.now() })

    checkForUpdatesFromMenu()

    await vi.waitFor(() => {
      expect(fetchNewerReleaseTagsMock).toHaveBeenCalledWith('1.3.17', 1, {
        includePrerelease: false
      })
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)
    })
    expect(autoUpdaterMock.setFeedURL).toHaveBeenLastCalledWith({
      provider: 'generic',
      url: 'https://github.com/stablyai/orca/releases/download/v1.3.18'
    })
  })

  // Why: Shift-click opts into RC updates, but the native GitHub provider can
  // still select cancelled prerelease tags with missing manifests. Keep the
  // manifest-probed generic feed path so those tags are skipped.
  it('uses the manifest-probed generic feed after a Shift-click RC opt-in', async () => {
    appMock.getVersion.mockReturnValue('1.3.17')
    fetchNewerReleaseTagsMock.mockResolvedValue(['v1.3.18-rc.1'])
    autoUpdaterMock.checkForUpdates.mockResolvedValue(undefined)

    const { setupAutoUpdater, checkForUpdatesFromMenu } = await import('./updater')

    const mainWindow = { webContents: { send: vi.fn() } }
    setupAutoUpdater(mainWindow as never, { getLastUpdateCheckAt: () => Date.now() })

    checkForUpdatesFromMenu({ includePrerelease: true })

    await vi.waitFor(() => {
      expect(fetchNewerReleaseTagsMock).toHaveBeenCalledWith('1.3.17', 2, {
        includePrerelease: true
      })
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)
    })
    expect(autoUpdaterMock.allowPrerelease).toBe(true)
    expect(autoUpdaterMock.setFeedURL).toHaveBeenLastCalledWith({
      provider: 'generic',
      url: 'https://github.com/stablyai/orca/releases/download/v1.3.18-rc.1'
    })
  })
})
