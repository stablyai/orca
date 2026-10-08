import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { getUserPluginsDir } from './plugin-discovery'
import { installPluginFromLocalPath } from './plugin-install'
import {
  createUninstallFixture,
  holdNextUninstallRefresh,
  latestPluginLog,
  latestUninstallWorker,
  prepareUninstallFixture,
  removeThroughPluginIpc,
  resetUninstallFixtures,
  uninstallGate,
  uninstallWorkerPorts
} from './__mocks__/plugin-uninstall-log-test-fixture'

beforeEach(prepareUninstallFixture)
afterEach(resetUninstallFixtures)

it('blocks fresh work while removal is pending and restores admission after failure', async () => {
  const { service, install } = await createUninstallFixture()
  const key = await install('failure', {
    panels: [{ id: 'panel', title: 'Panel', entry: 'panel.html' }],
    events: [{ on: 'worktree.created' }]
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
    const workers = uninstallWorkerPorts.length
    expect(service.getGrantedCapabilities(key)).toEqual(['events:subscribe'])
    expect(service.getLogs(key)).toHaveLength(200)
    await expect(service.invokeCommand(key, 'run')).rejects.toThrow('not enabled')
    await expect(service.panels.readEntry(key, 'panel')).resolves.toBeNull()
    service.emitEvent('worktree.created', {
      worktreeId: 'fixture',
      path: 'synthetic-path',
      branch: 'main'
    })
    expect(uninstallWorkerPorts).toHaveLength(workers)
  } finally {
    release.resolve()
  }
  expect(await settled).toEqual(new Error('Controlled removal failure'))
  expect(service.findValidPlugin(key)).not.toBeNull()
  expect(service.getLogs(key)).toHaveLength(200)
  await service.invokeCommand(key, 'run')
  expect(latestUninstallWorker().connected).toBe(true)
})

it('publishes retirement before a held subsequent refresh can finish', async () => {
  const { service, install } = await createUninstallFixture()
  const key = await install('refresh-gap', {
    panels: [{ id: 'panel', title: 'Panel', entry: 'panel.html' }],
    events: [{ on: 'worktree.created' }]
  })
  const child = latestUninstallWorker()
  const held = holdNextUninstallRefresh(service)
  const removal = removeThroughPluginIpc(key)
  try {
    await held.entered.promise
    expect(service.findValidPlugin(key)).toBeNull()
    expect(service.getLogs(key)).toHaveLength(0)
    const workers = uninstallWorkerPorts.length
    await expect(service.invokeCommand(key, 'run')).rejects.toThrow('not enabled')
    await expect(service.panels.readEntry(key, 'panel')).resolves.toBeNull()
    service.emitEvent('worktree.created', {
      worktreeId: 'fixture',
      path: 'synthetic-path',
      branch: 'main'
    })
    child.emitLateLog('stale-during-refresh')
    expect(service.getLogs(key)).toHaveLength(0)
    expect(uninstallWorkerPorts).toHaveLength(workers)
  } finally {
    held.release.resolve()
    await removal
    held.restore()
  }
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

it('preserves installed crash history while cancelling the existing restart backoff', async () => {
  const { service, install } = await createUninstallFixture()
  const key = await install('crash')
  const child = latestUninstallWorker()
  child.connected = false
  child.emit('exit', 1)
  expect(latestPluginLog(service, key).line).toContain('exited unexpectedly')
  await service.deactivatePlugin(key)
  expect(service.findValidPlugin(key)).not.toBeNull()
  expect(service.getLogs(key)).toHaveLength(200)
})
