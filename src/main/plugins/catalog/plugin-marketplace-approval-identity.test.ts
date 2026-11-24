import '../../persistence/persistence-test-harness'
import { afterEach, expect, it } from 'vitest'
import { applyPluginConsent } from '../activation/plugin-enablement'
import { readPluginLockfile } from '../installation/plugin-install'
import {
  createMarketplaceReviewFixture,
  disposeMarketplaceReviewFixtures,
  REVIEW_ENTRY,
  REVIEW_KEY
} from './plugin-marketplace-review.test-fixture'

afterEach(disposeMarketplaceReviewFixtures)

it('refuses an old discovery review when a different install has already published', async () => {
  const f = await createMarketplaceReviewFixture()
  const first = await f.install(await f.tree('1.0.0'))
  await f.service.refresh()
  const next = await f.install(await f.tree('1.1.0', 'demo', [{ kind: 'notifications:show' }]))
  expect(next.contentHash).not.toBe(first.contentHash)
  expect(next.consentFingerprint).not.toBe(first.consentFingerprint)
  expect(f.service.findValidPlugin(REVIEW_KEY)?.contentHash).toBe(first.contentHash)
  await expect(
    applyPluginConsent({
      store: f.store,
      pluginService: f.service,
      pluginKey: REVIEW_KEY,
      reviewedFingerprint: first.consentFingerprint,
      decision: 'approve'
    })
  ).rejects.toThrow('changed since its permissions were reviewed')
  expect(f.store.getSettings().pluginConsents).toEqual({})
})

it('approves the same installed offer after another catalog revision and identical reinstall', async () => {
  const f = await createMarketplaceReviewFixture()
  const tree = await f.tree('1.0.0')
  const first = await f.install(tree)
  await f.service.refresh()
  await f.refresh()
  await f.install(tree)
  const entry = (await readPluginLockfile(f.pluginsDir)).plugins[REVIEW_KEY]
  expect(entry.source.kind === 'marketplace' && entry.source.marketplace.resolvedCommit).toBe(
    'c'.repeat(40)
  )
  await applyPluginConsent({
    store: f.store,
    pluginService: f.service,
    pluginKey: REVIEW_KEY,
    reviewedFingerprint: first.consentFingerprint,
    decision: 'approve'
  })
  expect(f.store.getSettings().pluginConsents?.[REVIEW_KEY]).toBe(first.consentFingerprint)
})

it.each(['withdrawn', 'replaced'] as const)(
  'refuses fresh approval when the installed offer is %s',
  async (offer) => {
    const f = await createMarketplaceReviewFixture()
    const installed = await f.install(await f.tree('1.0.0'))
    await f.service.refresh()
    await f.refresh(
      offer === 'withdrawn'
        ? []
        : [{ ...REVIEW_ENTRY, source: { ...REVIEW_ENTRY.source, ref: 'next' } }]
    )
    await expect(
      applyPluginConsent({
        store: f.store,
        pluginService: f.service,
        pluginKey: REVIEW_KEY,
        reviewedFingerprint: installed.consentFingerprint,
        decision: 'approve'
      })
    ).rejects.toThrow('review the plugin again')
    expect(f.store.getSettings().pluginConsents).toEqual({})
  }
)
