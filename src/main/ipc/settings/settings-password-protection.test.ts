import { beforeEach, describe, expect, it } from 'vitest'
import {
  handleMock,
  rebuildAppMenuMock,
  store,
  settingsInvokeEvent,
  confirmBrowserPasswordOwnerMock,
  sanitizeDirectoryMock
} from './testing/settings-ipc-test-fixture'
import { registerSettingsHandlers } from './settings'
import { nativeTheme } from 'electron'

describe('password fill protection settings', () => {
  beforeEach(() => {
    handleMock.mockClear()
    store.getSettings.mockReset()
    store.updateSettings.mockReset()
    store.updateSettingsAndFlush.mockReset()
    confirmBrowserPasswordOwnerMock.mockReset().mockResolvedValue(true)
    sanitizeDirectoryMock.mockReset().mockResolvedValue('')
  })

  it('checks current fill protection after a queued directory update resumes', async () => {
    store.getSettings.mockReturnValue({ browserPasswordsFillRequiresReauth: false })
    store.updateSettings.mockImplementation((updates) => {
      const next = { ...store.getSettings(), ...updates }
      store.getSettings.mockReturnValue(next)
      return next
    })
    let resume: (value: string) => void = () => {}
    sanitizeDirectoryMock.mockReturnValueOnce(
      new Promise((done) => {
        resume = done
      })
    )
    confirmBrowserPasswordOwnerMock.mockResolvedValue(false)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Only the settings methods supplied by this fixture are used.
    registerSettingsHandlers(store as never)
    const handler = handleMock.mock.calls.find(([channel]) => channel === 'settings:set')?.[1]
    const queued = handler(settingsInvokeEvent, {
      floatingTerminalCwd: '/queued',
      browserPasswordsFillRequiresReauth: false
    })
    await handler(settingsInvokeEvent, { browserPasswordsFillRequiresReauth: true })
    resume('/queued')
    expect(await queued).toMatchObject({
      browserPasswordsFillRequiresReauth: true,
      floatingTerminalCwd: '/queued'
    })
  })

  it('does not let an unauthenticated queued no-op disable newly enabled protection', async () => {
    store.getSettings.mockReturnValue({ browserPasswordsFillRequiresReauth: false })
    store.updateSettings.mockImplementation((updates) => {
      const next = { ...store.getSettings(), ...updates }
      store.getSettings.mockReturnValue(next)
      return next
    })
    let resume: () => void = () => {}
    const persistenceReady = new Promise<void>((done) => {
      resume = done
    })
    store.updateSettingsAndFlush.mockImplementation(async (updates) => {
      await persistenceReady
      return store.updateSettings(updates)
    })
    confirmBrowserPasswordOwnerMock.mockResolvedValue(false)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Only the settings methods supplied by this fixture are used.
    registerSettingsHandlers(store as never)
    const handler = handleMock.mock.calls.find(([channel]) => channel === 'settings:set')?.[1]
    const queued = handler(settingsInvokeEvent, {
      browserPasswordsFillRequiresReauth: false,
      alwaysForceDeleteWorktrees: true
    })
    await handler(settingsInvokeEvent, { browserPasswordsFillRequiresReauth: true })
    resume()
    expect(await queued).toMatchObject({
      browserPasswordsFillRequiresReauth: true,
      alwaysForceDeleteWorktrees: true
    })
    expect(confirmBrowserPasswordOwnerMock).not.toHaveBeenCalled()
  })
})

describe('settings file changes reaching the main process', () => {
  type PersistedListener = (changed: Record<string, unknown>, origin: string | undefined) => void

  function registerAndCapturePersistedListener(): PersistedListener {
    let listener: PersistedListener = () => {}
    store.onSettingsPersisted.mockImplementation((next: PersistedListener) => {
      listener = next
      return () => {}
    })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Only the settings methods supplied by this fixture are used.
    registerSettingsHandlers(store as never)
    return (changed, origin) => listener(changed, origin)
  }

  beforeEach(() => {
    rebuildAppMenuMock.mockClear()
    nativeTheme.themeSource = 'system'
    store.getSettings.mockReset().mockReturnValue({ theme: 'dark' })
  })

  it('applies a settings-file theme change to the native theme', () => {
    registerAndCapturePersistedListener()({ theme: 'dark' }, 'settings-file')

    expect(nativeTheme.themeSource).toBe('dark')
  })

  it('applies a settings-file appearance change to the app menu', () => {
    registerAndCapturePersistedListener()({ showTasksButton: false }, 'settings-file')

    expect(rebuildAppMenuMock).toHaveBeenCalledTimes(1)
  })

  it('leaves the native theme alone for changes that did not come from the settings file', () => {
    registerAndCapturePersistedListener()({ theme: 'dark' }, undefined)

    expect(nativeTheme.themeSource).toBe('system')
  })
})
