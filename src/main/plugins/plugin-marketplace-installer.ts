import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PluginManifest } from '../../shared/plugins/plugin-manifest'
import { getUserPluginsDir } from './plugin-discovery'
import { checkoutPluginGitSource } from './plugin-git-repository'
import {
  installPluginFromMarketplace,
  readPluginLockfile,
  rollbackInstalledPlugin,
  type PluginInstallResult
} from './plugin-install'
import { inspectPluginInstallTree } from './plugin-install-staging'
import type {
  PluginMarketplaceListing,
  PluginMarketplaceService
} from './plugin-marketplace-service'
import { marketplaceSourceId } from './plugin-marketplace-store'

export type PluginMarketplaceInstallPreview = {
  marketplaceSourceId: string
  marketplaceName: string
  marketplaceOwner: string
  marketplaceCommit: string
  pluginKey: string
  source: PluginMarketplaceListing['source']
  resolvedCommit: string
  contentHash: string
  consentFingerprint: string
  manifest: PluginManifest
  official: boolean
  bundled: boolean
  blockedByKillList?: { reason: string; advisoryUrl?: string }
}

export type PluginMarketplacePreviewIdentity = Pick<
  PluginMarketplaceInstallPreview,
  'marketplaceSourceId' | 'marketplaceCommit' | 'pluginKey' | 'resolvedCommit'
>

export class PluginMarketplaceInstaller {
  private readonly marketplace: PluginMarketplaceService
  private readonly userDataPath: string
  private readonly hostVersion: string
  private readonly blockedPluginReason: (pluginKey: string) => string | null

  constructor(options: {
    marketplace: PluginMarketplaceService
    userDataPath: string
    hostVersion: string
    blockedPluginReason?: (pluginKey: string) => string | null
  }) {
    this.marketplace = options.marketplace
    this.userDataPath = options.userDataPath
    this.hostVersion = options.hostVersion
    this.blockedPluginReason = options.blockedPluginReason ?? (() => null)
  }

  async preview(
    marketplaceSourceId: string,
    pluginKey: string
  ): Promise<PluginMarketplaceInstallPreview> {
    const listing = await this.requireListing(marketplaceSourceId, pluginKey)
    const stagingDirectory = await mkdtemp(join(tmpdir(), 'orca-plugin-marketplace-preview-'))
    try {
      const resolvedCommit = await checkoutPluginGitSource({
        url: listing.source.url,
        ref: listing.source.ref,
        destination: stagingDirectory,
        workingDirectory: tmpdir()
      })
      const inspection = await inspectPluginInstallTree({
        rootDir: stagingDirectory,
        hostVersion: this.hostVersion,
        expectedPluginKey: pluginKey
      })
      if (!inspection.ok) {
        throw new Error(inspection.error)
      }
      return {
        marketplaceSourceId,
        marketplaceName: listing.marketplaceName,
        marketplaceOwner: listing.marketplaceOwner,
        marketplaceCommit: listing.marketplaceCommit,
        pluginKey,
        source: listing.source,
        resolvedCommit,
        contentHash: inspection.contentHash,
        consentFingerprint: inspection.consentFingerprint,
        manifest: inspection.manifest,
        official: listing.official,
        bundled: listing.bundled,
        ...(listing.blockedByKillList ? { blockedByKillList: listing.blockedByKillList } : {})
      }
    } finally {
      await rm(stagingDirectory, { recursive: true, force: true })
    }
  }

  async install(preview: PluginMarketplacePreviewIdentity): Promise<PluginInstallResult> {
    const listing = await this.requireListing(preview.marketplaceSourceId, preview.pluginKey)
    const blockedReason =
      listing.blockedByKillList?.reason ?? this.blockedPluginReason(preview.pluginKey)
    if (blockedReason) {
      return { ok: false, error: `plugin is blocked by Orca's safety list: ${blockedReason}` }
    }
    if (listing.marketplaceCommit !== preview.marketplaceCommit) {
      return { ok: false, error: 'marketplace changed after preview; review the plugin again' }
    }
    const sourceState = (await this.marketplace.listSources()).find(
      (source) => source.id === preview.marketplaceSourceId
    )
    if (!sourceState) {
      return { ok: false, error: 'marketplace source is no longer configured' }
    }
    return installPluginFromMarketplace({
      pluginsDir: getUserPluginsDir(this.userDataPath),
      hostVersion: this.hostVersion,
      expectedPluginKey: preview.pluginKey,
      expectedResolvedCommit: preview.resolvedCommit,
      marketplace: {
        url: sourceState.source.url,
        ref: sourceState.source.ref,
        resolvedCommit: preview.marketplaceCommit
      },
      plugin: { url: listing.source.url, ref: listing.source.ref },
      blockedPluginReason: this.blockedPluginReason
    })
  }

  async previewInstalledUpdate(pluginKey: string): Promise<PluginMarketplaceInstallPreview> {
    const lock = await readPluginLockfile(getUserPluginsDir(this.userDataPath))
    const entry = lock.plugins[pluginKey]
    if (!entry || entry.source.kind !== 'marketplace') {
      throw new Error(`plugin ${pluginKey} was not installed from a marketplace`)
    }
    const sourceId = marketplaceSourceId({
      kind: 'git',
      url: entry.source.marketplace.url,
      ref: entry.source.marketplace.ref
    })
    return this.preview(sourceId, pluginKey)
  }

  async rollback(pluginKey: string): Promise<PluginInstallResult> {
    return rollbackInstalledPlugin({
      pluginsDir: getUserPluginsDir(this.userDataPath),
      pluginKey,
      hostVersion: this.hostVersion,
      blockedPluginReason: this.blockedPluginReason
    })
  }

  private async requireListing(
    marketplaceSourceId: string,
    pluginKey: string
  ): Promise<PluginMarketplaceListing> {
    const listing = await this.marketplace.findPlugin(marketplaceSourceId, pluginKey)
    if (!listing) {
      throw new Error(`plugin ${pluginKey} is not listed by marketplace ${marketplaceSourceId}`)
    }
    return listing
  }
}
