import { expect, it, vi } from 'vitest'
import { getDefaultNotificationSettings } from '../../../shared/notification-settings-defaults'
import {
  createWorkerMaintenanceFixture,
  maintenanceBarrier
} from './profile-state-maintenance-fixture'

vi.mock('../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: () => ({ nth_repo_added: 2 })
}))
vi.mock('../../ssh/ssh-config-parser', () => ({
  loadUserSshConfig: () => ({ hosts: [] }),
  sshConfigHostsToTargets: () => []
}))

it.each([false, true])(
  'publishes current notification settings after a durable save with a newer notification edit: %s',
  async (newerNotificationEdit) => {
    const { store, authority, readState } = await createWorkerMaintenanceFixture()
    await store.updateSettingsAndFlush({ notifications: getDefaultNotificationSettings() })
    let clientSettings = store.getSettings()
    const onChanged = vi.fn((updates) => {
      clientSettings = { ...clientSettings, ...updates }
    })
    store.onSettingsChanged(onChanged)
    const started = maintenanceBarrier()
    const release = maintenanceBarrier()
    const write = authority.writeSerializedDomains.bind(authority)
    vi.spyOn(authority, 'writeSerializedDomains').mockImplementationOnce(async (domains) => {
      started.resolve()
      await release.promise
      await write(domains)
    })
    const pending = store.updateSettingsAndFlush(
      { notifications: { ...getDefaultNotificationSettings(), enabled: false } },
      { notifyListeners: true }
    )
    await started.promise
    const durableNotifications = store.getSettings().notifications
    store.updateSettings(
      newerNotificationEdit
        ? { notifications: getDefaultNotificationSettings() }
        : { theme: 'dark' },
      { notifyListeners: true }
    )
    expect(store.getSettings().notifications).not.toBe(durableNotifications)
    release.resolve()
    await pending

    const expectedEnabled = newerNotificationEdit
    expect(store.getSettings().notifications?.enabled).toBe(expectedEnabled)
    expect.soft(clientSettings.notifications?.enabled).toBe(expectedEnabled)
    await store.flushPendingOrThrowAsync()
    expect(readState().settings.notifications.enabled).toBe(expectedEnabled)
    if (!newerNotificationEdit) {
      expect
        .soft(onChanged)
        .toHaveBeenLastCalledWith(
          { notifications: store.getSettings().notifications },
          expect.objectContaining({ notifications: store.getSettings().notifications }),
          undefined
        )
      expect(readState().settings.theme).toBe('dark')
    }
  }
)

it.each([
  { name: 'empty', updates: {} },
  { name: 'unchanged theme', updates: { theme: 'system' } }
] as const)(
  'reconciles an $name reply that exposed a failed notification setting',
  async ({ updates }) => {
    const { store, authority, readState } = await createWorkerMaintenanceFixture()
    await store.updateSettingsAndFlush({ notifications: getDefaultNotificationSettings() })
    let clientSettings = store.getSettings()
    store.onSettingsChanged((changed) => {
      clientSettings = { ...clientSettings, ...changed }
    })
    const started = maintenanceBarrier()
    const release = maintenanceBarrier()
    vi.spyOn(authority, 'writeSerializedDomains').mockImplementationOnce(async () => {
      started.resolve()
      await release.promise
      throw new Error('Disk full')
    })
    const pending = store.updateSettingsAndFlush(
      { notifications: { ...getDefaultNotificationSettings(), enabled: false } },
      { notifyListeners: true, originWebContentsId: 7 }
    )
    const rejected = expect(pending).rejects.toThrow('Disk full')
    await started.promise
    clientSettings = store.updateSettings(updates, {
      notifyListeners: true,
      originWebContentsId: 7
    })
    expect(clientSettings.notifications?.enabled).toBe(false)
    release.resolve()
    await rejected

    expect.soft(store.getSettings().notifications?.enabled).toBe(true)
    expect.soft(clientSettings.notifications?.enabled).toBe(true)
    await store.flushPendingOrThrowAsync()
    expect.soft(readState().settings.notifications.enabled).toBe(true)
  }
)

it.each([false, true])(
  'rolls back only owned notification settings after a failed save with a newer notification edit: %s',
  async (newerNotificationEdit) => {
    const { store, authority, readState } = await createWorkerMaintenanceFixture()
    await store.updateSettingsAndFlush({ notifications: getDefaultNotificationSettings() })
    let clientSettings = store.getSettings()
    store.onSettingsChanged((updates) => {
      clientSettings = { ...clientSettings, ...updates }
    })
    const started = maintenanceBarrier()
    const release = maintenanceBarrier()
    vi.spyOn(authority, 'writeSerializedDomains').mockImplementationOnce(async () => {
      started.resolve()
      await release.promise
      throw new Error('Disk full')
    })
    const pending = store.updateSettingsAndFlush(
      { notifications: { ...getDefaultNotificationSettings(), enabled: false } },
      { notifyListeners: true }
    )
    const rejected = expect(pending).rejects.toThrow('Disk full')
    await started.promise
    const durableNotifications = store.getSettings().notifications
    const reply = store.updateSettings(
      newerNotificationEdit
        ? { notifications: { ...getDefaultNotificationSettings(), enabled: false } }
        : { theme: 'dark' },
      { notifyListeners: true }
    )
    if (!newerNotificationEdit) {
      clientSettings = reply
    }
    expect(store.getSettings().notifications).not.toBe(durableNotifications)
    release.resolve()
    await rejected

    const expectedEnabled = !newerNotificationEdit
    expect.soft(store.getSettings().notifications?.enabled).toBe(expectedEnabled)
    expect.soft(clientSettings.notifications?.enabled).toBe(expectedEnabled)
    await store.flushPendingOrThrowAsync()
    expect.soft(readState().settings.notifications.enabled).toBe(expectedEnabled)
    if (!newerNotificationEdit) {
      expect(readState().settings.theme).toBe('dark')
    }
  }
)
