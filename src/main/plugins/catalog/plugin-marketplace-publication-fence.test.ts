import '../../persistence/persistence-test-harness'
import { cp, rm } from 'node:fs/promises'
import type * as FsPromises from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import * as pluginGit from '../installation/plugin-git-repository'
import { PluginMarketplaceInstaller } from './plugin-marketplace-installer'
import {
  createMarketplaceReviewFixture,
  disposeMarketplaceReviewFixtures,
  REVIEW_KEY
} from './plugin-marketplace-review.test-fixture'

vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof FsPromises>()
  return { ...fs, rm: vi.fn(fs.rm) }
})
const realRm = (await vi.importActual<typeof FsPromises>('node:fs/promises')).rm
afterEach(async () => {
  vi.restoreAllMocks()
  vi.mocked(rm).mockImplementation(realRm)
  await disposeMarketplaceReviewFixtures()
})

it('releases the catalog generation after publication before pruning retained files', async () => {
  const f = await createMarketplaceReviewFixture()
  const first = await f.install(await f.tree('1.0.0'))
  await f.install(await f.tree('1.1.0'))
  const next = await f.tree('1.2.0')
  vi.spyOn(pluginGit, 'checkoutPluginGitSource').mockImplementation(async ({ destination }) => {
    await cp(next, destination, { recursive: true })
    return 'b'.repeat(40)
  })
  let catalogReleased = false
  const guard = f.marketplace.withSourceSnapshot.bind(f.marketplace)
  vi.spyOn(f.marketplace, 'withSourceSnapshot').mockImplementation(
    async <T>(sourceId: string, write: () => T | Promise<T>): Promise<T> => {
      const result = await guard(sourceId, write)
      catalogReleased = true
      return result
    }
  )
  const pruning = Promise.withResolvers<void>()
  const releasePrune = Promise.withResolvers<void>()
  let releasedBeforePruning = false
  vi.mocked(rm).mockImplementation(async (path, options) => {
    if (path === join(f.pluginsDir, REVIEW_KEY, first.contentHash)) {
      releasedBeforePruning = catalogReleased
      pruning.resolve()
      await releasePrune.promise
    }
    return realRm(path, options)
  })
  const installer = new PluginMarketplaceInstaller({
    marketplace: f.marketplace,
    userDataPath: f.root,
    hostVersion: '1.4.0',
    revokeConsent: async () => undefined
  })
  const preview = await installer.previewInstalledUpdate(REVIEW_KEY)
  const installing = installer.install(preview)
  try {
    await pruning.promise
    expect(releasedBeforePruning).toBe(true)
    await f.refresh([])
  } finally {
    releasePrune.resolve()
    expect(await installing).toMatchObject({ ok: true, version: '1.2.0' })
  }
})
