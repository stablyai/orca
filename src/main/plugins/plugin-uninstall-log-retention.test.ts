import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { getPluginsDataDir, getUserPluginsDir } from './plugin-discovery'
import { readPluginLockfile } from './plugin-install'
import type { PluginManifest } from '../../shared/plugins/plugin-manifest'
import {
  createUninstallFixture,
  latestPluginLog,
  latestUninstallWorker,
  prepareUninstallFixture,
  removeThroughPluginIpc,
  resetUninstallFixtures,
  uninstallContentVerifier,
  uninstallGate,
  uninstallWorkerPorts
} from './__mocks__/plugin-uninstall-log-test-fixture'

beforeEach(prepareUninstallFixture)
afterEach(resetUninstallFixtures)

it('releases eight removed log rings while their old worker callback ports remain rooted', async () => {
  const { root, service, install } = await createUninstallFixture()
  const refs: WeakRef<object>[] = []
  for (let index = 0; index < 8; index += 1) {
    const key = await install(`retired-${index}`)
    expect(service.getLogs(key)).toHaveLength(200)
    refs.push(new WeakRef(latestPluginLog(service, key)))
    await removeThroughPluginIpc(key)
    expect(service.findValidPlugin(key)).toBeNull()
    expect(service.getLogs(key)).toHaveLength(0)
    expect((await readPluginLockfile(getUserPluginsDir(root))).plugins[key]).toBeUndefined()
    await expect(stat(join(getUserPluginsDir(root), key))).rejects.toThrow()
  }
  const collect = global.gc
  if (!collect) {
    throw new Error('Run retention tests with --expose-gc')
  }
  for (let index = 0; index < 6; index += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve))
    collect()
  }
  expect(uninstallWorkerPorts).toHaveLength(8)
  expect(uninstallWorkerPorts.every((port) => !port.connected)).toBe(true)
  expect(refs.filter((ref) => ref.deref())).toHaveLength(0)
})

it('preserves installed stopped history and fences old callbacks from same-key reinstall', async () => {
  const { service, install } = await createUninstallFixture()
  const key = await install('reused')
  await service.deactivatePlugin(key)
  expect(service.findValidPlugin(key)).not.toBeNull()
  expect(service.getLogs(key)).toHaveLength(200)
  const old = latestUninstallWorker()
  await removeThroughPluginIpc(key)
  await install('reused')
  old.emitLateLog('old worker callback')
  expect(latestUninstallWorker().connected).toBe(true)
  expect(latestPluginLog(service, key).line).toBe('log-204')
})

it('retains history after partial filesystem failure and releases it after a successful retry', async () => {
  const { root, service, store, install } = await createUninstallFixture()
  const key = await install('retry')
  const dataDir = getPluginsDataDir(root)
  const outside = join(root, 'outside-data')
  await mkdir(dataDir, { recursive: true })
  await mkdir(outside, { recursive: true })
  await writeFile(join(outside, 'preserve.txt'), 'fixture')
  await symlink(outside, join(dataDir, key), process.platform === 'win32' ? 'junction' : 'dir')
  await expect(removeThroughPluginIpc(key)).rejects.toThrow('outside')
  await expect(stat(join(getUserPluginsDir(root), key))).rejects.toThrow()
  expect((await readPluginLockfile(getUserPluginsDir(root))).plugins[key]).toBeDefined()
  expect(store.getSettings().pluginConsents[key]).toBeDefined()
  expect(service.findValidPlugin(key)).not.toBeNull()
  expect(service.getLogs(key)).toHaveLength(200)
  await rm(join(dataDir, key))
  await removeThroughPluginIpc(key)
  expect(service.findValidPlugin(key)).toBeNull()
  expect(service.getLogs(key)).toHaveLength(0)
})

it('does not recreate a removed key when its exited worker flushes a final stdio tail', async () => {
  const { service, install } = await createUninstallFixture()
  const key = await install('late-tail')
  const child = latestUninstallWorker()
  child.stdout.write('tail-owned-by-retiring-worker')
  await removeThroughPluginIpc(key)
  expect(child.connected).toBe(false)
  child.stdout.end()
  await new Promise<void>((resolve) => setImmediate(resolve))
  expect(service.getLogs(key)).toHaveLength(0)
})

it.each(['panel', 'event'] as const)(
  'fences late %s verification errors from a same-key successor',
  async (kind) => {
    const { service, install } = await createUninstallFixture()
    const contributes: Partial<PluginManifest['contributes']> =
      kind === 'panel'
        ? { panels: [{ id: 'panel', title: 'Panel', entry: 'panel.html' }] }
        : { events: [{ on: 'worktree.created' }] }
    const key = await install(`late-${kind}`, contributes)
    const held = uninstallGate()
    const verify = vi
      .spyOn(uninstallContentVerifier(service), 'verify')
      .mockImplementationOnce(() => held.promise)
    const panelResult = kind === 'panel' ? service.panels.readEntry(key, 'panel') : null
    if (kind === 'event') {
      service.emitEvent('worktree.created', {
        worktreeId: 'fixture',
        path: 'synthetic-path',
        branch: 'main'
      })
    }
    expect(verify).toHaveBeenCalledOnce()
    verify.mockRestore()
    try {
      await removeThroughPluginIpc(key)
      await install(`late-${kind}`, contributes)
    } finally {
      held.reject(new Error('Controlled old verification rejection'))
      await panelResult
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
    expect(latestUninstallWorker().connected).toBe(true)
    expect(latestPluginLog(service, key).line).toBe('log-204')
  }
)
