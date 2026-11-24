import '../../persistence/persistence-test-harness'
import { cp } from 'node:fs/promises'
import { afterEach, expect, it, vi } from 'vitest'
import * as pluginGit from '../installation/plugin-git-repository'
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

it('preserves a pre-existing valid rollback directory when reusing its bytes is refused', async () => {
  const f = await createMarketplaceReviewFixture()
  const previous = await f.tree('1.0.0')
  await f.install(previous)
  await f.install(await f.tree('1.1.0'))
  vi.spyOn(pluginGit, 'checkoutPluginGitSource').mockImplementation(async ({ destination }) => {
    await cp(previous, destination, { recursive: true })
    return 'a'.repeat(40)
  })
  const installer = new PluginMarketplaceInstaller({
    marketplace: f.marketplace,
    userDataPath: f.root,
    hostVersion: '1.4.0',
    revokeConsent: async () => undefined
  })
  const preview = await installer.previewInstalledUpdate(REVIEW_KEY)
  const guard = f.marketplace.withSourceSnapshot.bind(f.marketplace)
  vi.spyOn(f.marketplace, 'withSourceSnapshot').mockImplementation(
    async <T>(sourceId: string, write: () => T | Promise<T>): Promise<T> => {
      await f.refresh([])
      return guard(sourceId, write)
    }
  )
  expect(await installer.install(preview)).toEqual({
    ok: false,
    error: 'marketplace changed after preview; review the plugin again'
  })
  expect(await installer.rollbackVersion(REVIEW_KEY)).toBe('1.0.0')
  expect(await installer.rollback(REVIEW_KEY)).toMatchObject({ ok: true, version: '1.0.0' })
})
