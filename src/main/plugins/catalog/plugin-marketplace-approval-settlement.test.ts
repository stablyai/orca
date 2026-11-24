import '../../persistence/persistence-test-harness'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { applyPluginConsent } from '../activation/plugin-enablement'
import { readPluginLockfile } from '../installation/plugin-install'
import { installCatalogReleaseWithApproval } from './plugin-update-approval'
import {
  createMarketplaceReviewFixture,
  disposeMarketplaceReviewFixtures,
  REVIEW_KEY
} from './plugin-marketplace-review.test-fixture'

afterEach(disposeMarketplaceReviewFixtures)

it('reports a published install as pending review when its later approval is refused', async () => {
  const f = await createMarketplaceReviewFixture()
  const tree = await f.tree('1.0.0')
  const path = join(tree, 'orca-plugin.json')
  const manifest = JSON.parse(await readFile(path, 'utf8'))
  manifest.contributes = {}
  await writeFile(path, JSON.stringify(manifest))
  const result = await installCatalogReleaseWithApproval({
    pluginKey: REVIEW_KEY,
    pluginService: f.service,
    install: () => f.install(tree),
    enableIfData: {},
    approve: async (pluginKey, reviewedFingerprint) => {
      await f.refresh([])
      await applyPluginConsent({
        store: f.store,
        pluginService: f.service,
        pluginKey,
        reviewedFingerprint,
        decision: 'approve'
      })
    }
  })
  expect(result).toMatchObject({ ok: true, needsReview: true, version: '1.0.0' })
  expect((await readPluginLockfile(f.pluginsDir)).plugins[REVIEW_KEY].contentHash).toBe(
    result.ok && result.contentHash
  )
  expect(f.store.getSettings().pluginConsents).toEqual({})
})
