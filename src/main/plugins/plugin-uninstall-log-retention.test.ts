import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { getPluginsDataDir, getUserPluginsDir } from './plugin-discovery'
import { readPluginLockfile } from './installation/plugin-install'
import type { PluginManifest } from '../../shared/plugins/manifest/plugin-manifest'
import {
  createUninstallFixture,
  latestPluginLog,
  latestUninstallWorker,
  prepareUninstallFixture,
  removeThroughPluginIpc,
  resetUninstallFixtures,
  uninstallContentVerifier,
  uninstallGate
} from './__mocks__/plugin-uninstall-log-test-fixture'

beforeEach(prepareUninstallFixture)
afterEach(resetUninstallFixtures)

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
  // Consent is revoked before deletion and the lock drops the entry whose install dir is gone.
  expect((await readPluginLockfile(getUserPluginsDir(root))).plugins[key]).toBeUndefined()
  expect(store.getSettings().pluginConsents[key]).toBeUndefined()
  expect(service.findValidPlugin(key)).not.toBeNull()
  expect(service.getLogs(key)).toHaveLength(200)
  await rm(join(dataDir, key))
  await removeThroughPluginIpc(key)
  expect(service.findValidPlugin(key)).toBeNull()
  expect(service.getLogs(key)).toHaveLength(0)
})

it.each(['panel', 'event'] as const)(
  'fences late %s verification errors from a same-key successor',
  async (kind) => {
    const { service, install } = await createUninstallFixture()
    const contributes: Partial<PluginManifest['contributes']> =
      kind === 'panel'
        ? { panels: [{ id: 'panel', title: 'Panel', entry: 'panel.html' }] }
        : { events: [{ on: 'workspace.created' }] }
    const key = await install(`late-${kind}`, contributes)
    const held = uninstallGate()
    if (kind === 'event') {
      // Why: a running worker takes events without re-hashing; a stopped one verifies at spawn.
      await service.deactivatePlugin(key)
    }
    const verify = vi
      .spyOn(uninstallContentVerifier(service), kind === 'panel' ? 'verify' : 'verifyNow')
      .mockImplementationOnce(() => held.promise)
    const panelResult = kind === 'panel' ? service.panels.readEntry(key, 'panel') : null
    if (kind === 'event') {
      service.emitEvent('workspace.created', {
        workspaceId: 'fixture',
        kind: 'worktree',
        path: 'synthetic-path',
        branch: 'main'
      })
    }
    await vi.waitFor(() => expect(verify).toHaveBeenCalledOnce())
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
