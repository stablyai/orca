import { beforeEach, describe, expect, it } from 'vitest'
import {
  handleMock,
  store,
  settingsInvokeEvent,
  confirmBrowserPasswordOwnerMock,
  sanitizeDirectoryMock
} from './settings-ipc-test-fixture'
import { registerSettingsHandlers } from './settings'

describe('password fill protection settings', () => {
  beforeEach(() => {
    handleMock.mockClear()
    store.getSettings.mockReset()
    store.updateSettings.mockReset()
    store.updateSettingsAndFlush.mockReset()
    confirmBrowserPasswordOwnerMock.mockReset().mockResolvedValue(true)
    sanitizeDirectoryMock.mockReset().mockResolvedValue('')
  })
  it.each([false, null, 'false'])(
    'retains fill protection for a refused or malformed disabling value %j',
    async (requested) => {
      store.getSettings.mockReturnValue({ browserPasswordsFillRequiresReauth: true })
      store.updateSettings.mockImplementation((updates) => {
        const next = { ...store.getSettings(), ...updates }
        store.getSettings.mockReturnValue(next)
        return next
      })
      confirmBrowserPasswordOwnerMock.mockResolvedValue(false)
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Only the settings methods supplied by this fixture are used.
      registerSettingsHandlers(store as never)
      const handler = handleMock.mock.calls.find(([channel]) => channel === 'settings:set')?.[1]
      const result = await handler(settingsInvokeEvent, {
        browserPasswordsFillRequiresReauth: requested,
        showTasksButton: true
      })
      expect(result).toMatchObject({
        browserPasswordsFillRequiresReauth: true,
        showTasksButton: true
      })
    }
  )

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

  it('requires fresh owner confirmation to disable fill protection', async () => {
    store.getSettings.mockReturnValue({ browserPasswordsFillRequiresReauth: true })
    store.updateSettings.mockImplementation((updates) => {
      const next = { ...store.getSettings(), ...updates }
      store.getSettings.mockReturnValue(next)
      return next
    })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Only the settings methods supplied by this fixture are used.
    registerSettingsHandlers(store as never)
    const handler = handleMock.mock.calls.find(([channel]) => channel === 'settings:set')?.[1]
    expect(
      await handler(settingsInvokeEvent, { browserPasswordsFillRequiresReauth: false })
    ).toMatchObject({ browserPasswordsFillRequiresReauth: false })
    expect(confirmBrowserPasswordOwnerMock).toHaveBeenCalledWith(expect.any(String), {
      always: true
    })
  })
})
