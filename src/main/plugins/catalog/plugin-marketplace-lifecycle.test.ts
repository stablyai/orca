import '../../persistence/persistence-test-harness'
import { cp } from 'node:fs/promises'
import { afterEach, expect, it, vi } from 'vitest'
import { revokePluginConsent } from '../activation/plugin-enablement'
import { uninstallInstalledPlugin } from '../installation/plugin-uninstall'
import * as pluginGit from '../installation/plugin-git-repository'
import * as atomicWrite from '../installation/plugin-atomic-file-write'
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

it('settles a repository move and real uninstall without awaiting lifecycle under the install lock', async () => {
  const f = await createMarketplaceReviewFixture()
  const first = await f.install(await f.tree('1.0.0'))
  await f.install(await f.tree('1.0.0', 'other'), 'samples.other')
  f.store.updateSettings({ pluginConsents: { [REVIEW_KEY]: first.consentFingerprint } })
  await f.service.refresh()
  await f.refresh([
    {
      ...REVIEW_ENTRY,
      source: { ...REVIEW_ENTRY.source, url: 'https://github.com/samples/moved.git' }
    }
  ])
  const next = await f.tree('1.1.0')
  vi.spyOn(pluginGit, 'checkoutPluginGitSource').mockImplementation(async ({ destination }) => {
    await cp(next, destination, { recursive: true })
    return 'b'.repeat(40)
  })
  const staged = Promise.withResolvers<void>()
  const releaseStage = Promise.withResolvers<void>()
  const rename = atomicWrite.renamePluginFileWithWindowsRetry
  vi.spyOn(atomicWrite, 'renamePluginFileWithWindowsRetry').mockImplementation(async (from, to) => {
    await rename(from, to)
    if (from.endsWith('.staging')) {
      staged.resolve()
      await releaseStage.promise
    }
  })
  const queuedRemoval = Promise.withResolvers<void>()
  const remove = f.service.removePlugin.bind(f.service)
  vi.spyOn(f.service, 'removePlugin').mockImplementation((key, work) =>
    remove(key, () => {
      const pending = work()
      queuedRemoval.resolve()
      return pending
    })
  )
  const reconcile = vi.spyOn(f.service, 'reconcileActivationState')
  const revoking = Promise.withResolvers<void>()
  const escapeOldCycle = Promise.withResolvers<void>()
  let reconciledUnderInstall = false
  const options = {
    marketplace: f.marketplace,
    userDataPath: f.root,
    hostVersion: '1.4.0',
    revokeConsent: (pluginKey: string) => {
      const before = reconcile.mock.calls.length
      const pending = revokePluginConsent({ store: f.store, pluginService: f.service, pluginKey })
      reconciledUnderInstall = reconcile.mock.calls.length > before
      revoking.resolve()
      // Only releases the old implementation's deadlock after the invariant fails.
      return Promise.race([pending, escapeOldCycle.promise])
    },
    reconcileConsent: () => f.service.reconcileActivationState()
  }
  const installer = new PluginMarketplaceInstaller(options)
  const preview = await installer.previewInstalledUpdate(REVIEW_KEY)
  const updating = installer.install(preview)
  await staged.promise
  const removing = uninstallInstalledPlugin({
    pluginService: f.service,
    store: f.store,
    pluginKey: 'samples.other'
  })
  await queuedRemoval.promise
  releaseStage.resolve()
  try {
    await revoking.promise
    expect(reconciledUnderInstall).toBe(false)
  } finally {
    escapeOldCycle.resolve()
    const [updated, removed] = await Promise.all([updating, removing])
    expect(updated).toMatchObject({ ok: true, repositoryMoved: true })
    expect(removed).toBe(true)
  }
  expect(f.store.getSettings().pluginConsents?.[REVIEW_KEY]).toBeUndefined()
})
