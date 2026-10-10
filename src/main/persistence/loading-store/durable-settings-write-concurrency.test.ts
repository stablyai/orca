import { expect, it, vi } from 'vitest'
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

it('preserves a newer click choice and its legacy switch after a failed durable save', async () => {
  const { store, authority } = await createWorkerMaintenanceFixture()
  const started = maintenanceBarrier()
  const release = maintenanceBarrier()
  vi.spyOn(authority, 'writeSerializedDomains').mockImplementationOnce(async () => {
    started.resolve()
    await release.promise
    throw new Error('Disk full')
  })
  const pending = store.updateSettingsAndFlush({ terminalLinkClickBehavior: 'none' })
  const rejected = expect(pending).rejects.toThrow('Disk full')
  await started.promise
  store.updateSettings({ terminalLinkClickBehavior: 'open' })
  release.resolve()
  await rejected

  expect(store.getSettings()).toMatchObject({
    terminalLinkClickBehavior: 'open',
    terminalLinkActionPopoverEnabled: false
  })
})

it.each([
  {
    name: 'legacy opt-out',
    updates: [{ terminalLinkActionPopoverEnabled: false }],
    expected: { terminalLinkClickBehavior: 'actions', terminalLinkActionPopoverEnabled: false }
  },
  {
    name: 'repeated explicit choice',
    updates: [{ terminalLinkClickBehavior: 'none' }],
    expected: { terminalLinkClickBehavior: 'none', terminalLinkActionPopoverEnabled: false }
  },
  {
    name: 'explicit choice restored after another edit',
    updates: [{ terminalLinkClickBehavior: 'open' }, { terminalLinkClickBehavior: 'none' }],
    expected: { terminalLinkClickBehavior: 'none', terminalLinkActionPopoverEnabled: false }
  }
] as const)(
  'retains a newer $name after an earlier durable click choice fails',
  async ({ updates, expected }) => {
    const { store, authority, readState } = await createWorkerMaintenanceFixture()
    await store.updateSettingsAndFlush({ terminalLinkClickBehavior: 'actions' })
    const started = maintenanceBarrier()
    const release = maintenanceBarrier()
    vi.spyOn(authority, 'writeSerializedDomains').mockImplementationOnce(async () => {
      started.resolve()
      await release.promise
      throw new Error('Disk full')
    })
    const pending = store.updateSettingsAndFlush({ terminalLinkClickBehavior: 'none' })
    const rejected = expect(pending).rejects.toThrow('Disk full')
    await started.promise
    for (const update of updates) {
      store.updateSettings(update)
    }
    release.resolve()
    await rejected

    expect(store.getSettings()).toMatchObject(expected)
    await store.flushPendingOrThrowAsync()
    expect(readState().settings).toMatchObject(expected)
  }
)

it.each(['none', 'actions'] as const)(
  'publishes current click settings after a durable save and a newer %s choice',
  async (behavior) => {
    const { store, authority, readState } = await createWorkerMaintenanceFixture()
    await store.updateSettingsAndFlush({ terminalLinkClickBehavior: 'none' })
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
      { terminalLinkClickBehavior: 'actions', alwaysForceDeleteWorktrees: true },
      { notifyListeners: true }
    )
    await started.promise
    store.updateSettings({ terminalLinkClickBehavior: behavior }, { notifyListeners: true })
    release.resolve()
    await pending

    const expected = {
      terminalLinkClickBehavior: behavior,
      terminalLinkActionPopoverEnabled: behavior === 'actions',
      alwaysForceDeleteWorktrees: true
    }
    expect(store.getSettings()).toMatchObject(expected)
    expect(clientSettings).toMatchObject(expected)
    expect(onChanged).toHaveBeenLastCalledWith(
      behavior === 'actions' ? expected : { alwaysForceDeleteWorktrees: true },
      expect.objectContaining(expected),
      undefined
    )
    await store.flushPendingOrThrowAsync()
    expect(readState().settings).toMatchObject(expected)
  }
)

it('publishes a retained same-value legacy opt-out after a durable choice fails', async () => {
  const { store, authority, readState } = await createWorkerMaintenanceFixture()
  await store.updateSettingsAndFlush({ terminalLinkClickBehavior: 'actions' })
  let clientSettings = store.getSettings()
  const onChanged = vi.fn((updates) => {
    clientSettings = { ...clientSettings, ...updates }
  })
  store.onSettingsChanged(onChanged)
  const started = maintenanceBarrier()
  const release = maintenanceBarrier()
  vi.spyOn(authority, 'writeSerializedDomains').mockImplementationOnce(async () => {
    started.resolve()
    await release.promise
    throw new Error('Disk full')
  })
  const pending = store.updateSettingsAndFlush(
    { terminalLinkClickBehavior: 'none' },
    { notifyListeners: true, originWebContentsId: 7 }
  )
  const rejected = expect(pending).rejects.toThrow('Disk full')
  await started.promise
  store.updateSettings(
    { terminalLinkActionPopoverEnabled: false },
    { notifyListeners: true, originWebContentsId: 7 }
  )
  release.resolve()
  await rejected

  const expected = {
    terminalLinkClickBehavior: 'actions',
    terminalLinkActionPopoverEnabled: false
  }
  expect(store.getSettings()).toMatchObject(expected)
  expect(clientSettings).toMatchObject(expected)
  expect(onChanged).toHaveBeenLastCalledWith(expected, expect.objectContaining(expected), undefined)
  await store.flushPendingOrThrowAsync()
  expect(readState().settings).toMatchObject(expected)
})

it('keeps persistence writable when rollback reconciliation cannot reach an observer', async () => {
  const { store, authority } = await createWorkerMaintenanceFixture()
  await store.updateSettingsAndFlush({ terminalLinkClickBehavior: 'actions' })
  const unsubscribe = store.onSettingsChanged(() => {
    throw new Error('Renderer disconnected')
  })
  const started = maintenanceBarrier()
  const release = maintenanceBarrier()
  vi.spyOn(authority, 'writeSerializedDomains').mockImplementationOnce(async () => {
    started.resolve()
    await release.promise
    throw new Error('Disk full')
  })
  const pending = store.updateSettingsAndFlush(
    { terminalLinkClickBehavior: 'none' },
    { notifyListeners: true }
  )
  const rejected = pending.catch((error) => error.message)
  await started.promise
  store.updateSettings({ terminalLinkActionPopoverEnabled: false }, { notifyListeners: true })
  release.resolve()
  const reason = await rejected
  unsubscribe()
  expect.soft(reason).toBe('Disk full')

  await expect(store.updateSettingsAndFlush({ terminalFontSize: 18 })).resolves.toMatchObject({
    terminalFontSize: 18
  })
})

it('clears an absent optional setting exposed by a newer reply when a durable write fails', async () => {
  const { store, authority } = await createWorkerMaintenanceFixture()
  delete store.getSettings().hostSettingOverrides
  await store.updateSettingsAndFlush({ terminalLinkClickBehavior: 'actions' })
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
    { terminalLinkClickBehavior: 'none', hostSettingOverrides: { local: {} } },
    { notifyListeners: true, originWebContentsId: 7 }
  )
  const rejected = expect(pending).rejects.toThrow('Disk full')
  await started.promise
  clientSettings = store.updateSettings({ terminalLinkActionPopoverEnabled: false })
  expect(clientSettings.hostSettingOverrides).toEqual({ local: {} })
  release.resolve()
  await rejected

  expect(Object.hasOwn(store.getSettings(), 'hostSettingOverrides')).toBe(false)
  expect(clientSettings.hostSettingOverrides).toBeUndefined()
})

it('publishes current settings when a newer choice arrives before failure delivery', async () => {
  const { store, authority } = await createWorkerMaintenanceFixture()
  await store.updateSettingsAndFlush({ terminalLinkClickBehavior: 'actions' })
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
    { terminalLinkClickBehavior: 'none' },
    { notifyListeners: true }
  )
  const rejected = expect(pending).rejects.toThrow('Disk full')
  await started.promise
  store.updateSettings({ terminalLinkActionPopoverEnabled: false })
  const unsubscribe = store.onWorkspaceSessionWritten(() => {
    unsubscribe()
    queueMicrotask(() => {
      store.updateSettings({ terminalLinkClickBehavior: 'open' }, { notifyListeners: true })
    })
  })
  release.resolve()
  await rejected

  const expected = {
    terminalLinkClickBehavior: 'open',
    terminalLinkActionPopoverEnabled: false
  }
  expect(store.getSettings()).toMatchObject(expected)
  expect(clientSettings).toMatchObject(expected)
})
