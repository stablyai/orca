import '../../persistence/persistence-test-harness'
import { cp, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { PLUGIN_CONTENT_HASH_PATTERN } from '../../../shared/plugins/installation/plugin-install-lockfile'
import * as pluginGit from '../installation/plugin-git-repository'
import * as atomicWrite from '../installation/plugin-atomic-file-write'
import { PluginMarketplaceInstaller } from './plugin-marketplace-installer'
import {
  createMarketplaceReviewFixture,
  disposeMarketplaceReviewFixtures,
  REVIEW_KEY
} from './plugin-marketplace-review.test-fixture'

afterEach(async () => {
  vi.restoreAllMocks()
  await disposeMarketplaceReviewFixtures()
})

it.each(['fresh', 'installed', 'rollback'] as const)(
  'preserves published versions after a late refusal (%s)',
  async (state) => {
    const f = await createMarketplaceReviewFixture()
    const hasRollback = state === 'rollback'
    if (state !== 'fresh') {
      await f.install(await f.tree('1.0.0'))
    }
    if (hasRollback) {
      await f.install(await f.tree('1.1.0'))
    }
    const next = await f.tree('1.2.0')
    vi.spyOn(pluginGit, 'checkoutPluginGitSource').mockImplementation(async ({ destination }) => {
      await cp(next, destination, { recursive: true })
      return 'b'.repeat(40)
    })
    const installer = new PluginMarketplaceInstaller({
      marketplace: f.marketplace,
      userDataPath: f.root,
      hostVersion: '1.4.0',
      revokeConsent: async () => {
        throw new Error('no repository move')
      }
    })
    const before = await installer.rollbackVersion(REVIEW_KEY)
    expect(before).toBe(hasRollback ? '1.0.0' : null)
    const preview = await installer.preview(f.source.id, REVIEW_KEY)
    const rename = atomicWrite.renamePluginFileWithWindowsRetry
    vi.spyOn(atomicWrite, 'renamePluginFileWithWindowsRetry').mockImplementation(
      async (from, to) => {
        await rename(from, to)
        if (from.endsWith('.staging')) {
          await f.refresh([])
        }
      }
    )
    expect(await installer.install(preview)).toEqual({
      ok: false,
      error: 'marketplace changed after preview; review the plugin again'
    })
    expect(await installer.rollbackVersion(REVIEW_KEY)).toBe(before)
    const pluginDir = join(f.pluginsDir, REVIEW_KEY)
    if (state === 'fresh') {
      await expect(readdir(pluginDir)).rejects.toMatchObject({ code: 'ENOENT' })
    } else {
      expect(
        (await readdir(pluginDir)).filter((name) => PLUGIN_CONTENT_HASH_PATTERN.test(name))
      ).toHaveLength(hasRollback ? 2 : 1)
    }
    if (hasRollback) {
      expect(await installer.rollback(REVIEW_KEY)).toMatchObject({ ok: true, version: '1.0.0' })
    }
  }
)
