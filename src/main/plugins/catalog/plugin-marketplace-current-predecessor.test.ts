import '../../persistence/persistence-test-harness'
import { cp } from 'node:fs/promises'
import { afterEach, expect, it, vi } from 'vitest'
import { revokePluginConsent } from '../activation/plugin-enablement'
import * as pluginGit from '../installation/plugin-git-repository'
import * as pluginInstall from '../installation/plugin-install'
import { serializePluginMutation } from '../installation/plugin-mutation-queue'
import { PluginMarketplaceInstaller } from './plugin-marketplace-installer'
import {
  createMarketplaceReviewFixture,
  disposeMarketplaceReviewFixtures,
  REVIEW_ENTRY,
  REVIEW_KEY
} from './plugin-marketplace-review.test-fixture'

afterEach(async () => {
  vi.restoreAllMocks()
  await disposeMarketplaceReviewFixtures()
})

it('decides repository movement from the predecessor captured inside the install queue', async () => {
  const f = await createMarketplaceReviewFixture()
  await f.install(await f.tree('1.0.0'))
  await f.service.refresh()
  const replacement = await f.tree('1.1.0')
  const next = await f.tree('1.2.0')
  vi.spyOn(pluginGit, 'checkoutPluginGitSource').mockImplementation(async ({ destination }) => {
    await cp(next, destination, { recursive: true })
    return 'e'.repeat(40)
  })
  const queued = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const intervening = serializePluginMutation(f.pluginsDir, async () => {
    queued.resolve()
    await release.promise
    const installed = await f.install(
      replacement,
      REVIEW_KEY,
      { ...REVIEW_ENTRY.source, url: 'https://github.com/samples/intervening.git' },
      'b'.repeat(40)
    )
    f.store.updateSettings({ pluginConsents: { [REVIEW_KEY]: installed.consentFingerprint } })
  })
  await queued.promise
  const options = {
    marketplace: f.marketplace,
    userDataPath: f.root,
    hostVersion: '1.4.0',
    revokeConsent: (pluginKey: string) =>
      revokePluginConsent({ store: f.store, pluginService: f.service, pluginKey }),
    reconcileConsent: () => f.service.reconcileActivationState()
  }
  const installer = new PluginMarketplaceInstaller(options)
  const preview = await installer.previewInstalledUpdate(REVIEW_KEY)
  expect(preview.repositoryMoved).toBeUndefined()
  const admitted = Promise.withResolvers<void>()
  const install = pluginInstall.installPluginFromMarketplace
  vi.spyOn(pluginInstall, 'installPluginFromMarketplace').mockImplementation((input) => {
    const pending = install(input)
    admitted.resolve()
    return pending
  })
  const updating = installer.install(preview)
  try {
    await admitted.promise
  } finally {
    release.resolve()
    await intervening
  }
  expect(await updating).toMatchObject({ ok: true, repositoryMoved: true })
  expect(f.store.getSettings().pluginConsents?.[REVIEW_KEY]).toBeUndefined()
})
