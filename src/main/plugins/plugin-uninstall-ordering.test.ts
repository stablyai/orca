import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { getPluginsDataDir, getUserPluginsDir } from './plugin-discovery'
import {
  installPluginFromLocalPath,
  readPluginLockfile,
  removeInstalledPlugin
} from './plugin-install'
import {
  createUninstallFixture,
  holdNextUninstallRefresh,
  latestUninstallWorker,
  prepareUninstallFixture,
  publishBundledUninstallSuccessor,
  removeThroughPluginIpc,
  requireInstalledPlugin,
  resetUninstallFixtures,
  uninstallGate,
  uninstallWorkerController
} from './__mocks__/plugin-uninstall-log-test-fixture'

beforeEach(prepareUninstallFixture)
afterEach(resetUninstallFixtures)

it('resolves removal after an ordinary earlier refresh replaces the discovery object', async () => {
  const { root, service, install } = await createUninstallFixture()
  const key = await install('identity')
  const prior = requireInstalledPlugin(service, key)
  const refresh = service.refresh()
  const removal = service.removePlugin(key, async () => {
    expect(requireInstalledPlugin(service, key)).not.toBe(prior)
    await removeInstalledPlugin({
      pluginsDir: getUserPluginsDir(root),
      pluginsDataDir: getPluginsDataDir(root),
      pluginKey: key
    })
  })
  await refresh
  await removal
  expect(service.findValidPlugin(key)).toBeNull()
  expect(service.getLogs(key)).toHaveLength(0)
})

it('actual IPC removal survives an immediately preceding queued refresh', async () => {
  const { service, install } = await createUninstallFixture()
  const key = await install('ipc-refresh')
  const original = service.removePlugin.bind(service)
  let refreshed: Promise<void> | undefined
  vi.spyOn(service, 'removePlugin').mockImplementation((pluginKey, operation) => {
    refreshed = service.refresh()
    return original(pluginKey, operation)
  })
  await removeThroughPluginIpc(key)
  await refreshed
  expect(service.findValidPlugin(key)).toBeNull()
  expect(service.getLogs(key)).toHaveLength(0)
})

it('resolves the new installed revision inside the queue before removing the requested key', async () => {
  const { root, service, install } = await createUninstallFixture()
  const key = await install('updated')
  const prior = requireInstalledPlugin(service, key)
  const sourcePath = join(root, 'sources', 'updated')
  await writeFile(
    join(sourcePath, 'worker.js'),
    'export default function () { /* new revision */ }'
  )
  const installed = await installPluginFromLocalPath({
    pluginsDir: getUserPluginsDir(root),
    sourcePath,
    hostVersion: '1.4.0'
  })
  expect(installed.ok).toBe(true)
  const refresh = service.refresh()
  const removal = service.removePlugin(key, async () => {
    expect(requireInstalledPlugin(service, key).contentHash).not.toBe(prior.contentHash)
    await removeInstalledPlugin({
      pluginsDir: getUserPluginsDir(root),
      pluginsDataDir: getPluginsDataDir(root),
      pluginKey: key
    })
  })
  await refresh
  await removal
  expect(service.findValidPlugin(key)).toBeNull()
})

it('retains a bundled plugin worker and history when ordinary IPC removal is refused', async () => {
  const { root, service, install } = await createUninstallFixture()
  const key = await install('orca-bundled', {}, true)
  await publishBundledUninstallSuccessor(root, 'orca-bundled', key)
  await service.refresh()
  await service.invokeCommand(key, 'run')
  const child = latestUninstallWorker()
  await expect(removeThroughPluginIpc(key)).rejects.toThrow('protected')
  expect(child.connected).toBe(true)
  expect(service.getLogs(key)).toHaveLength(200)
  expect((await readPluginLockfile(getUserPluginsDir(root))).plugins[key]?.source.kind).toBe(
    'bundled'
  )
})

it('checks bundled ownership after an earlier queued refresh before deactivation', async () => {
  const { root, service, install } = await createUninstallFixture()
  const key = await install('orca-queued', {}, true)
  const held = holdNextUninstallRefresh(service)
  const deactivate = vi.spyOn(uninstallWorkerController(service), 'deactivate')
  const refresh = service.refresh()
  const remove = vi.fn(async () => {})
  const failed = service.removePlugin(key, remove).catch((error: unknown) => error)
  try {
    await held.entered.promise
    await publishBundledUninstallSuccessor(root, 'orca-queued', key)
  } finally {
    held.release.resolve()
  }
  await refresh
  const calls = deactivate.mock.calls.length
  expect(await failed).toEqual(
    expect.objectContaining({ message: expect.stringContaining('protected') })
  )
  expect(deactivate).toHaveBeenCalledTimes(calls)
  expect(remove).not.toHaveBeenCalled()
  expect(service.getLogs(key)).toHaveLength(200)
  held.restore()
})

it('rechecks bundled ownership under the filesystem queue after a held worker shutdown', async () => {
  const { root, service, install } = await createUninstallFixture()
  const key = await install('orca-deactivate', {}, true)
  const controller = uninstallWorkerController(service)
  const original = controller.deactivate.bind(controller)
  const entered = uninstallGate()
  const release = uninstallGate()
  vi.spyOn(controller, 'deactivate').mockImplementationOnce(async (pluginKey) => {
    await original(pluginKey)
    entered.resolve()
    await release.promise
  })
  const failed = removeThroughPluginIpc(key).catch((error: unknown) => error)
  try {
    await entered.promise
    await publishBundledUninstallSuccessor(root, 'orca-deactivate', key)
  } finally {
    release.resolve()
  }
  expect(await failed).toEqual(
    expect.objectContaining({ message: expect.stringContaining('protected') })
  )
  expect((await readPluginLockfile(getUserPluginsDir(root))).plugins[key]?.source.kind).toBe(
    'bundled'
  )
  await stat(join(getUserPluginsDir(root), key))
  expect(service.getLogs(key)).toHaveLength(200)
  await service.refresh()
  await service.invokeCommand(key, 'run')
  expect(latestUninstallWorker().connected).toBe(true)
})
