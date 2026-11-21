import { afterEach, beforeEach, expect, it } from 'vitest'
import { mkdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { getPluginsDataDir, getUserPluginsDir } from '../discovery/plugin-discovery'
import { readPluginLockfile } from './plugin-install-lockfile-store'
import {
  createUninstallFixture,
  prepareUninstallFixture,
  removeThroughPluginIpc,
  resetUninstallFixtures
} from '../__mocks__/plugin-uninstall-log-test-fixture'

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
