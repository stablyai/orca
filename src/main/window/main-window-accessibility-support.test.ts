import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  appOnMock,
  appRemoveListenerMock,
  isAccessibilitySupportEnabledMock,
  handleMock,
  removeHandlerMock
} = vi.hoisted(() => ({
  appOnMock: vi.fn(),
  appRemoveListenerMock: vi.fn(),
  isAccessibilitySupportEnabledMock: vi.fn(() => false),
  handleMock: vi.fn(),
  removeHandlerMock: vi.fn()
}))

vi.mock('electron', () => ({
  app: {
    isAccessibilitySupportEnabled: isAccessibilitySupportEnabledMock,
    on: appOnMock,
    removeListener: appRemoveListenerMock
  },
  ipcMain: {
    handle: handleMock,
    removeHandler: removeHandlerMock
  }
}))

import { installMainWindowAccessibilitySupport } from './main-window-accessibility-support'

function createMainWindow(
  isDestroyed = false,
  webContentsDestroyed = false
): {
  isDestroyed: () => boolean
  webContents: { send: ReturnType<typeof vi.fn>; isDestroyed: () => boolean }
} {
  return {
    isDestroyed: () => isDestroyed,
    webContents: { send: vi.fn(), isDestroyed: () => webContentsDestroyed }
  }
}

function changedListener(): (event: unknown, enabled: boolean) => void {
  const registration = appOnMock.mock.calls.find(
    ([event]) => event === 'accessibility-support-changed'
  )
  expect(registration).toBeDefined()
  return registration![1] as (event: unknown, enabled: boolean) => void
}

describe('installMainWindowAccessibilitySupport', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    isAccessibilitySupportEnabledMock.mockReturnValue(false)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('answers the getter from Electron so a late-mounting pane can seed itself', () => {
    const mainWindow = createMainWindow()
    installMainWindowAccessibilitySupport({
      mainWindow: mainWindow as unknown as Electron.BrowserWindow
    })
    const [channel, handler] = handleMock.mock.calls[0] as [string, () => boolean]
    expect(channel).toBe('window:isAccessibilitySupportEnabled')
    isAccessibilitySupportEnabledMock.mockReturnValue(true)
    expect(handler()).toBe(true)
  })

  it('forwards both directions of the change to the renderer', () => {
    const mainWindow = createMainWindow()
    installMainWindowAccessibilitySupport({
      mainWindow: mainWindow as unknown as Electron.BrowserWindow
    })
    const onChanged = changedListener()
    // A pane has mounted and asked, which is what makes a later change something to forward.
    const [, getter] = handleMock.mock.calls[0] as [string, () => boolean]
    expect(getter()).toBe(false)

    isAccessibilitySupportEnabledMock.mockReturnValue(true)
    onChanged({}, true)
    vi.advanceTimersByTime(5_000)

    isAccessibilitySupportEnabledMock.mockReturnValue(false)
    onChanged({}, false)
    vi.advanceTimersByTime(5_000)

    expect(mainWindow.webContents.send.mock.calls).toEqual([
      ['window:accessibility-support-changed', true],
      ['window:accessibility-support-changed', false]
    ])
  })

  /**
   * The behaviour that decides whether this feature works at all. Measured on macOS 26.5.1: attaching a
   * client emitted the event carrying `false` while the getter went true two and a half seconds
   * later and emitted nothing more.
   */
  it('ignores the payload and follows the getter, however late it settles', () => {
    const mainWindow = createMainWindow()
    installMainWindowAccessibilitySupport({
      mainWindow: mainWindow as unknown as Electron.BrowserWindow
    })

    // A pane has already asked and been told `false`, which is what the renderer is holding.
    const [, getter] = handleMock.mock.calls[0] as [string, () => boolean]
    expect(getter()).toBe(false)

    // The event lies, and at event time so does the getter, so there is nothing to correct yet.
    changedListener()({}, false)
    vi.advanceTimersByTime(300)
    expect(mainWindow.webContents.send).not.toHaveBeenCalled()

    // Chromium finishes turning it on, with no second event to announce it.
    isAccessibilitySupportEnabledMock.mockReturnValue(true)
    vi.advanceTimersByTime(2_500)
    expect(mainWindow.webContents.send).toHaveBeenCalledWith(
      'window:accessibility-support-changed',
      true
    )
  })

  /**
   * The measured 2.4 s was an idle machine, and no second event follows the real transition -- so a
   * schedule that gave up early would leave the panes unreadable for the life of the window.
   */
  it('still catches a settle that takes far longer than the one measured', () => {
    const mainWindow = createMainWindow()
    installMainWindowAccessibilitySupport({
      mainWindow: mainWindow as unknown as Electron.BrowserWindow
    })
    const [, getter] = handleMock.mock.calls[0] as [string, () => boolean]
    getter()

    changedListener()({}, false)
    vi.advanceTimersByTime(30_000)
    expect(mainWindow.webContents.send).not.toHaveBeenCalled()

    isAccessibilitySupportEnabledMock.mockReturnValue(true)
    vi.advanceTimersByTime(10_000)
    expect(mainWindow.webContents.send).toHaveBeenCalledWith(
      'window:accessibility-support-changed',
      true
    )
  })

  /** Once the answer has changed there is nothing left for the schedule to wait for. */
  it('stops reading once the answer changes', () => {
    const mainWindow = createMainWindow()
    installMainWindowAccessibilitySupport({
      mainWindow: mainWindow as unknown as Electron.BrowserWindow
    })
    const [, getter] = handleMock.mock.calls[0] as [string, () => boolean]
    getter()

    changedListener()({}, false)
    isAccessibilitySupportEnabledMock.mockReturnValue(true)
    vi.advanceTimersByTime(1_000)
    const readsWhenItLanded = isAccessibilitySupportEnabledMock.mock.calls.length

    vi.advanceTimersByTime(60_000)
    expect(isAccessibilitySupportEnabledMock.mock.calls.length).toBe(readsWhenItLanded)
    expect(mainWindow.webContents.send).toHaveBeenCalledTimes(1)
  })

  it('sends nothing while the answer matches what the renderer already has', () => {
    const mainWindow = createMainWindow()
    installMainWindowAccessibilitySupport({
      mainWindow: mainWindow as unknown as Electron.BrowserWindow
    })
    isAccessibilitySupportEnabledMock.mockReturnValue(true)
    const [, getter] = handleMock.mock.calls[0] as [string, () => boolean]
    expect(getter()).toBe(true)

    changedListener()({}, true)
    vi.advanceTimersByTime(10_000)
    expect(mainWindow.webContents.send).not.toHaveBeenCalled()
  })

  /**
   * Nothing has asked, so there is nobody to tell -- and every pane host reads the getter when it
   * registers, so `undefined` really does mean nobody. Sending the first read anyway would be
   * sending the value taken before Chromium finished.
   */
  it('says nothing to a renderer that has never asked', () => {
    const mainWindow = createMainWindow()
    installMainWindowAccessibilitySupport({
      mainWindow: mainWindow as unknown as Electron.BrowserWindow
    })
    changedListener()({}, true)
    vi.advanceTimersByTime(60_000)
    expect(mainWindow.webContents.send).not.toHaveBeenCalled()
  })

  /**
   * The sequence that made the baseline matter: a client attaches with no pane mounted, so the
   * first read is the early one -- and treating it as news would have published it and stopped the
   * schedule, leaving the real transition uncaught and no second event to announce it.
   */
  it('keeps reading after an early baseline, and catches the real transition', () => {
    const mainWindow = createMainWindow()
    installMainWindowAccessibilitySupport({
      mainWindow: mainWindow as unknown as Electron.BrowserWindow
    })

    // No pane has asked; the event arrives while the getter is still pre-settle.
    changedListener()({}, false)
    vi.advanceTimersByTime(300)
    expect(mainWindow.webContents.send).not.toHaveBeenCalled()

    isAccessibilitySupportEnabledMock.mockReturnValue(true)
    vi.advanceTimersByTime(2_500)
    expect(mainWindow.webContents.send.mock.calls).toEqual([
      ['window:accessibility-support-changed', true]
    ])
  })

  it('publishes a settled value once, not once per re-read', () => {
    const mainWindow = createMainWindow()
    installMainWindowAccessibilitySupport({
      mainWindow: mainWindow as unknown as Electron.BrowserWindow
    })
    const [, getter] = handleMock.mock.calls[0] as [string, () => boolean]
    getter()
    changedListener()({}, false)
    isAccessibilitySupportEnabledMock.mockReturnValue(true)
    vi.advanceTimersByTime(10_000)
    expect(mainWindow.webContents.send.mock.calls).toEqual([
      ['window:accessibility-support-changed', true]
    ])
  })

  /**
   * The gap that matters: webContents dies just before 'closed', and dispose() only clears the
   * timers at 'closed'. A settle read landing in between would send into a destroyed webContents.
   */
  it('does not send once webContents is gone but the window is not', () => {
    const mainWindow = createMainWindow(false, true)
    installMainWindowAccessibilitySupport({
      mainWindow: mainWindow as unknown as Electron.BrowserWindow
    })
    const [, getter] = handleMock.mock.calls[0] as [string, () => boolean]
    getter()

    changedListener()({}, true)
    isAccessibilitySupportEnabledMock.mockReturnValue(true)
    vi.advanceTimersByTime(60_000)
    expect(mainWindow.webContents.send).not.toHaveBeenCalled()
  })

  it('does not send into a destroyed window', () => {
    const mainWindow = createMainWindow(true)
    installMainWindowAccessibilitySupport({
      mainWindow: mainWindow as unknown as Electron.BrowserWindow
    })
    isAccessibilitySupportEnabledMock.mockReturnValue(true)
    changedListener()({}, true)
    vi.advanceTimersByTime(5_000)
    expect(mainWindow.webContents.send).not.toHaveBeenCalled()
  })

  /**
   * openMainWindow is not idempotent and openWindowWithRetry calls it again after a throw, up to
   * three times. This handler goes in early enough that a throw later in window construction
   * leaves it registered with no window to dispose it -- and a second ipcMain.handle on the same
   * channel throws, turning a transient failure into a permanent one.
   */
  it('survives being installed again after a window that threw', () => {
    const first = createMainWindow()
    installMainWindowAccessibilitySupport({
      mainWindow: first as unknown as Electron.BrowserWindow
    })
    // No dispose: this is the window whose construction threw after this point.
    const second = createMainWindow()
    installMainWindowAccessibilitySupport({
      mainWindow: second as unknown as Electron.BrowserWindow
    })

    expect(removeHandlerMock).toHaveBeenCalledWith('window:isAccessibilitySupportEnabled')
    expect(handleMock).toHaveBeenCalledTimes(2)
    // The channel is cleared before it is claimed again, which is what keeps the retry alive.
    const [firstRemove] = removeHandlerMock.mock.invocationCallOrder
    const secondHandle = handleMock.mock.invocationCallOrder[1]
    expect(firstRemove).toBeLessThan(secondHandle)

    // And the surviving handler answers for the window that actually opened.
    isAccessibilitySupportEnabledMock.mockReturnValue(true)
    const [, getter] = handleMock.mock.calls[1] as [string, () => boolean]
    expect(getter()).toBe(true)
  })

  /**
   * `published` tracks what the renderer has been told, and answering one asker is not telling it.
   * A read taken after the transition settled would otherwise match the next settle read, skip the
   * send, and leave whoever read the old value holding it.
   */
  it('does not let a later read hide the transition from an earlier one', () => {
    const mainWindow = createMainWindow()
    installMainWindowAccessibilitySupport({
      mainWindow: mainWindow as unknown as Electron.BrowserWindow
    })
    const [, getter] = handleMock.mock.calls[0] as [string, () => boolean]
    expect(getter()).toBe(false)

    changedListener()({}, false)
    isAccessibilitySupportEnabledMock.mockReturnValue(true)
    // A second asker reads the settled value directly.
    expect(getter()).toBe(true)

    // The first one still has to be told, and only the pushed event can do that.
    vi.advanceTimersByTime(5_000)
    expect(mainWindow.webContents.send).toHaveBeenCalledWith(
      'window:accessibility-support-changed',
      true
    )
  })

  it('releases the handler and the app listener on dispose', () => {
    const mainWindow = createMainWindow()
    const { dispose } = installMainWindowAccessibilitySupport({
      mainWindow: mainWindow as unknown as Electron.BrowserWindow
    })
    const onChanged = changedListener()
    // A re-read still pending must not fire into a window that is going away.
    onChanged({}, true)
    dispose()
    isAccessibilitySupportEnabledMock.mockReturnValue(true)
    vi.advanceTimersByTime(10_000)
    expect(mainWindow.webContents.send).not.toHaveBeenCalled()
    expect(removeHandlerMock).toHaveBeenCalledWith('window:isAccessibilitySupportEnabled')
    expect(appRemoveListenerMock).toHaveBeenCalledWith('accessibility-support-changed', onChanged)
  })
})
