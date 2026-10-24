import { compareAppVersions } from '../../../shared/app-version'
import {
  pluginUpdateAccessGrowth,
  pluginUpdateGrowsAccess
} from '../../../shared/plugins/approval/plugin-update-access-growth'
import type { PluginAutoUpdateState } from '../../../shared/plugins/catalog/plugin-update-policy'
import {
  isInvalidDiscoveredPlugin,
  type DiscoveredPlugin,
  type ValidDiscoveredPlugin
} from '../plugin-discovery'
import {
  installCatalogReleaseWithApproval,
  readApprovedPredecessor,
  type PluginCatalogInstallOutcome
} from './plugin-update-approval'
import type { PluginPolicySource } from '../plugin-activation-policy'
import type { PluginMarketplaceInstaller } from './plugin-marketplace-installer'
import type { PluginReleaseFirstSeenStore } from './plugin-release-first-seen-store'

// Why half the hold: a release first seen one pass ago is old enough by the second pass, not the third.
export const PLUGIN_AUTO_UPDATE_INTERVAL_MS = 6 * 60 * 60 * 1000
/** Why: a release must stay listed this long before it installs unasked, so takedowns can land. */
export const PLUGIN_AUTO_UPDATE_HOLD_BACK_MS = 12 * 60 * 60 * 1000

type AutoUpdatePluginService = {
  readonly options: PluginPolicySource
  getDiscovered: () => readonly DiscoveredPlugin[]
  findValidPlugin: (pluginKey: string) => ValidDiscoveredPlugin | null
  refresh: () => Promise<void>
}

type AutoUpdateInstaller = Pick<
  PluginMarketplaceInstaller,
  'findInstalledUpdateListing' | 'previewInstalledUpdate' | 'install'
>

/**
 * Installs catalog updates for enabled plugins when they ask for nothing new, like an editor's
 * extension auto-update. An update that grows access, or comes from a moved repository, is left
 * uninstalled and marked for review; the running version keeps running.
 */
export class PluginAutoUpdater {
  private readonly options: {
    pluginService: AutoUpdatePluginService
    installer: AutoUpdateInstaller
    firstSeen: Pick<PluginReleaseFirstSeenStore, 'firstSeen'>
    isEnabled: () => boolean
    refreshCatalogs: () => Promise<unknown>
    refreshKillList: () => Promise<unknown>
    approve: (pluginKey: string, reviewedFingerprint: string) => Promise<void>
    onChanged: (state: PluginAutoUpdateState, updatedNow: PluginAutoUpdateState['updated']) => void
    now?: () => number
  }
  private state: PluginAutoUpdateState = { updated: {}, needsReview: {} }
  private running: Promise<void> | null = null
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(options: PluginAutoUpdater['options']) {
    this.options = options
  }

  getState(): PluginAutoUpdateState {
    return this.state
  }

  /** One pass; concurrent callers share it. */
  run(): Promise<void> {
    this.running ??= this.performRun().finally(() => {
      this.running = null
    })
    return this.running
  }

  syncPeriodicRun(enabled: boolean, intervalMs = PLUGIN_AUTO_UPDATE_INTERVAL_MS): void {
    if (!enabled) {
      this.dispose()
      return
    }
    if (this.timer) {
      return
    }
    this.timer = setInterval(() => {
      void this.run().catch((error) => console.warn('[plugins] auto-update failed:', error))
    }, intervalMs)
    this.timer.unref?.()
  }

  dispose(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  private async performRun(): Promise<void> {
    if (!this.options.isEnabled()) {
      return
    }
    // Why before the refresh: a pass that starts exactly one hold later must see the hold as over.
    const startedAt = (this.options.now ?? Date.now)()
    await this.options
      .refreshCatalogs()
      .catch((error) => console.warn('[plugins] auto-update kept cached catalogs:', error))
    // Why once, lazily: the kill list can be hours old, so take a fresh copy only when about to install.
    let killListFresh: Promise<void> | null = null
    const refreshKillList = (): Promise<void> =>
      (killListFresh ??= this.options.refreshKillList().then(() => undefined))
    const updatedNow: PluginAutoUpdateState['updated'] = {}
    const needsReview: PluginAutoUpdateState['needsReview'] = {}
    for (const plugin of this.options.pluginService.getDiscovered()) {
      if (isInvalidDiscoveredPlugin(plugin) || !this.options.isEnabled()) {
        continue
      }
      try {
        const verdict = await this.updateOne(plugin, startedAt, refreshKillList)
        // Why logged: a headless or remote host has no toast, so the log is the only record.
        if (verdict?.kind === 'updated') {
          updatedNow[plugin.pluginKey] = verdict.version
          console.info(`[plugins] auto-updated ${plugin.pluginKey} to ${verdict.version}`)
        } else if (verdict?.kind === 'needs-review') {
          needsReview[plugin.pluginKey] = verdict.version
          console.info(`[plugins] update ${verdict.version} of ${plugin.pluginKey} needs review`)
        }
      } catch (error) {
        console.warn(`[plugins] auto-update skipped ${plugin.pluginKey}:`, error)
      }
    }
    const updated = { ...this.state.updated, ...updatedNow }
    for (const key of Object.keys(needsReview)) {
      delete updated[key]
    }
    this.state = { updated, needsReview }
    this.options.onChanged(this.state, updatedNow)
  }

  private async updateOne(
    plugin: ValidDiscoveredPlugin,
    now: number,
    refreshKillList: () => Promise<void>
  ): Promise<{ kind: 'updated' | 'needs-review'; version: string } | null> {
    const { pluginService, installer } = this.options
    // Why approved only: a disabled or never-approved plugin is the user's to update.
    if (!readApprovedPredecessor(pluginService.options, plugin)) {
      return null
    }
    const found = await installer.findInstalledUpdateListing(plugin.pluginKey)
    // Why pinned only: an unpinned listing installs a branch head, which can move after the hold.
    const release = found?.listing.release
    if (
      !found ||
      !release ||
      found.listing.blockedByKillList ||
      compareAppVersions(release.version, plugin.manifest.version) <= 0
    ) {
      return null
    }
    if (!found.officialCatalog) {
      const firstSeenAt = await this.options.firstSeen.firstSeen(
        plugin.pluginKey,
        `${release.version}@${release.commit}`,
        now
      )
      if (now - firstSeenAt < PLUGIN_AUTO_UPDATE_HOLD_BACK_MS) {
        return null
      }
    }
    const preview = await installer.previewInstalledUpdate(plugin.pluginKey)
    // Why: a catalog refresh since the hold check can list another release; install only the held one.
    if (
      preview.resolvedCommit !== release.commit ||
      preview.contentHash !== release.contentHash ||
      preview.contentHash === plugin.contentHash
    ) {
      return null
    }
    if (
      preview.repositoryMoved ||
      pluginUpdateGrowsAccess(pluginUpdateAccessGrowth(plugin.manifest, preview.manifest))
    ) {
      return { kind: 'needs-review', version: preview.manifest.version }
    }
    // Why fail closed: without a current kill list a takedown could not stop this install.
    await refreshKillList()
    const outcome: PluginCatalogInstallOutcome = await installCatalogReleaseWithApproval({
      pluginKey: plugin.pluginKey,
      pluginService,
      install: () => installer.install(preview, { requireInstalled: true }),
      approve: this.options.approve
    })
    if (!outcome.ok) {
      throw new Error(outcome.error)
    }
    return outcome.needsReview
      ? { kind: 'needs-review', version: outcome.version }
      : { kind: 'updated', version: outcome.version }
  }
}
