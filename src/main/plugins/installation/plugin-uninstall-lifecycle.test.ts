import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { getUserPluginsDir } from '../discovery/plugin-discovery'
import { installPluginFromLocalPath } from './plugin-install'
import {
  createUninstallFixture,
  latestPluginLog,
  latestUninstallWorker,
  prepareUninstallFixture,
  removeThroughPluginIpc,
  resetUninstallFixtures,
  uninstallGate
} from '../__mocks__/plugin-uninstall-log-test-fixture'

beforeEach(prepareUninstallFixture)
afterEach(resetUninstallFixtures)

it('blocks fresh work while removal is pending and restores admission after failure', async () => {
  const { service, install } = await createUninstallFixture()
  const key = await install('failure', {
    panels: [{ id: 'panel', title: 'Panel', entry: 'panel.html' }],
    events: [{ on: 'workspace.created' }]
  })
  const entered = uninstallGate()
  const release = uninstallGate()
  const settled = service
    .removePlugin(key, async () => {
      entered.resolve()
      await release.promise
      throw new Error('Controlled removal failure')
    })
    .catch((error: unknown) => error)
  try {
    await entered.promise
    expect(service.getGrantedCapabilities(key)).toBeNull()
    expect(service.getLogs(key)).toHaveLength(200)
    await expect(service.invokeCommand(key, 'run')).rejects.toThrow('not enabled')
    await expect(service.panels.readEntry(key, 'panel')).resolves.toBeNull()
    service.emitEvent('workspace.created', {
      workspaceId: 'fixture',
      kind: 'worktree',
      path: 'synthetic-path',
      branch: 'main'
    })
  } finally {
    release.resolve()
  }
  expect(await settled).toEqual(new Error('Controlled removal failure'))
  expect(service.findValidPlugin(key)).not.toBeNull()
  expect(service.getLogs(key)).toHaveLength(200)
  await service.invokeCommand(key, 'run')
})

it('queues identical reinstall discovery behind removal without clearing successor logs', async () => {
  const { root, service, store, install } = await createUninstallFixture()
  const key = await install('successor')
  const old = latestUninstallWorker()
  const entered = uninstallGate()
  const release = uninstallGate()
  const original = service.removePlugin.bind(service)
  vi.spyOn(service, 'removePlugin').mockImplementation((pluginKey, operation) =>
    original(pluginKey, async () => {
      await operation()
      entered.resolve()
      await release.promise
    })
  )
  const removal = removeThroughPluginIpc(key)
  let refreshed = false
  let refresh: Promise<void> | undefined
  try {
    await entered.promise
    const installed = await installPluginFromLocalPath({
      pluginsDir: getUserPluginsDir(root),
      sourcePath: join(root, 'sources', 'successor'),
      hostVersion: '1.4.0'
    })
    if (!installed.ok) {
      throw new Error(installed.error)
    }
    refresh = service.refresh().then(() => {
      refreshed = true
    })
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(refreshed).toBe(false)
    await expect(service.invokeCommand(key, 'run')).rejects.toThrow('not enabled')
    store.updateSettings({
      pluginConsents: { ...store.getSettings().pluginConsents, [key]: installed.consentFingerprint }
    })
  } finally {
    release.resolve()
    await removal
    await refresh
  }
  // Removal's IPC consent cleanup precedes the new user's grant.
  const plugin = service.findValidPlugin(key)
  if (!plugin) {
    throw new Error('Successor was not discovered')
  }
  store.updateSettings({
    pluginConsents: { ...store.getSettings().pluginConsents, [key]: plugin.consentFingerprint }
  })
  await service.refresh()
  await service.invokeCommand(key, 'run')
  expect(latestUninstallWorker()).not.toBe(old)
  old.emitLateLog('old-after-successor')
  expect(latestPluginLog(service, key).line).toBe('log-204')
})

it('waits for removal during service disposal and preserves history until success', async () => {
  const { service, install } = await createUninstallFixture()
  const key = await install('dispose')
  const entered = uninstallGate()
  const release = uninstallGate()
  const removal = service.removePlugin(key, async () => {
    entered.resolve()
    await release.promise
  })
  await entered.promise
  let disposed = false
  const disposal = service.dispose().then(() => {
    disposed = true
  })
  try {
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(disposed).toBe(false)
    expect(service.getLogs(key)).toHaveLength(200)
  } finally {
    release.resolve()
    await removal
    await disposal
  }
  expect(service.getLogs(key)).toHaveLength(0)
})

it('revokes consent and enablement state before deleting the plugin files', async () => {
  const { root, store, install } = await createUninstallFixture()
  const key = await install('atomic')
  store.updateSettings({ disabledPlugins: ['other.plugin', key] })
  const pluginDir = join(getUserPluginsDir(root), key)
  const original = store.updateSettings.bind(store)
  const filesPresentAtRevoke: boolean[] = []
  vi.spyOn(store, 'updateSettings').mockImplementation((patch) => {
    if (patch.pluginConsents && !(key in patch.pluginConsents)) {
      filesPresentAtRevoke.push(existsSync(pluginDir))
    }
    original(patch)
  })

  await removeThroughPluginIpc(key)

  expect(filesPresentAtRevoke).toEqual([true])
  expect(store.getSettings().pluginConsents).not.toHaveProperty(key)
  expect(store.getSettings().disabledPlugins).toEqual(['other.plugin'])
  expect(existsSync(pluginDir)).toBe(false)
})
