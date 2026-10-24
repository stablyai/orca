import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PluginManifest } from '../../../shared/plugins/manifest/plugin-manifest'
import { PLUGIN_IMAGE_RULES } from '../../../shared/plugins/plugin-image-fields'
import { pluginShaImageUrl, type PluginHostImages } from '../../../shared/plugins/plugin-image-url'
import { readContainedPluginArtifactBytes } from '../plugin-artifact-validation'
import { declaredPluginImages } from '../plugin-image-artifact-validation'
import type { PluginImageCache } from '../plugin-image-cache'
import { pluginManifestHostImages } from '../plugin-manifest-images'
import { pluginCatalogReleaseCompatibilityError } from '../../../shared/plugins/manifest/plugin-manifest-compatibility'
import { isQualifiedPluginKey } from '../../../shared/plugins/manifest/plugin-manifest'
import { getUserPluginsDir } from '../plugin-discovery'
import { readPluginRollbackVersion } from '../installation/plugin-rollback-candidate'
import { checkoutPluginGitSource } from '../installation/plugin-git-repository'
import {
  installPluginFromMarketplace,
  readPluginLockfile,
  rollbackInstalledPlugin,
  type PluginInstallResult
} from '../installation/plugin-install'
import { inspectPluginInstallTree } from '../installation/plugin-install-staging'
import type {
  PluginMarketplaceListing,
  PluginMarketplaceService
} from './plugin-marketplace-service'
import { marketplaceSourceId } from './plugin-marketplace-store'
import { fullAccessError, PLUGIN_FULL_ACCESS_OFF_ERROR } from '../plugin-activation-policy'
import { isSameGitRepository } from '../../../shared/plugins/catalog/plugin-marketplace'

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
  /** The manifest's images, verified at preview and cached by hash. */
  images?: PluginHostImages
  /** Update previews only: the catalog now points at a different repository than the install. */
  repositoryMoved?: true
}

/** `repositoryMoved`: this replaced an install that came from a different repository. */
export type PluginMarketplaceInstallResult = PluginInstallResult & { repositoryMoved?: true }

export type PluginMarketplacePreviewIdentity = Pick<
  PluginMarketplaceInstallPreview,
  'marketplaceSourceId' | 'marketplaceCommit' | 'pluginKey' | 'resolvedCommit'
>

export class PluginMarketplaceInstaller {
  private readonly marketplace: PluginMarketplaceService
  private readonly userDataPath: string
  private readonly hostVersion: string
  private readonly blockedPluginReason: (pluginKey: string) => string | null
  private readonly isFullAccessAllowed: () => boolean
  private readonly imageCache: PluginImageCache | null

  constructor(options: {
    marketplace: PluginMarketplaceService
    userDataPath: string
    hostVersion: string
    blockedPluginReason?: (pluginKey: string) => string | null
    isFullAccessAllowed?: () => boolean
    imageCache?: PluginImageCache
  }) {
    this.imageCache = options.imageCache ?? null
    this.marketplace = options.marketplace
    this.userDataPath = options.userDataPath
    this.hostVersion = options.hostVersion
    this.blockedPluginReason = options.blockedPluginReason ?? (() => null)
    this.isFullAccessAllowed = options.isFullAccessAllowed ?? (() => false)
  }

  async preview(
    marketplaceSourceId: string,
    pluginKey: string
  ): Promise<PluginMarketplaceInstallPreview> {
    const listing = await this.requireListing(marketplaceSourceId, pluginKey)
    const incompatible = this.releaseCompatibilityError(listing)
    if (incompatible) {
      throw new Error(incompatible)
    }
    const stagingDirectory = await mkdtemp(join(tmpdir(), 'orca-plugin-marketplace-preview-'))
    try {
      const resolvedCommit = await checkoutPluginGitSource({
        url: listing.source.url,
        // Why: a pinned release names its commit; the listed ref is only what the author calls it.
        ref: listing.release?.commit ?? listing.source.ref,
        destination: stagingDirectory,
        workingDirectory: tmpdir()
      })
      const inspection = await inspectPluginInstallTree({
        rootDir: stagingDirectory,
        hostVersion: this.hostVersion,
        expectedPluginKey: pluginKey,
        ...(listing.release ? { release: { record: listing.release, resolvedCommit } } : {})
      })
      if (!inspection.ok) {
        throw new Error(inspection.error)
      }
      const images = await this.cachePreviewImages(stagingDirectory, inspection.manifest)
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
        ...(listing.blockedByKillList ? { blockedByKillList: listing.blockedByKillList } : {}),
        ...(images ? { images } : {})
      }
    } finally {
      await rm(stagingDirectory, { recursive: true, force: true })
    }
  }

  async install(
    preview: PluginMarketplacePreviewIdentity,
    options: { requireInstalled?: boolean } = {}
  ): Promise<PluginMarketplaceInstallResult> {
    const listing = await this.requireListing(preview.marketplaceSourceId, preview.pluginKey)
    const blockedReason =
      listing.blockedByKillList?.reason ?? this.blockedPluginReason(preview.pluginKey)
    if (blockedReason) {
      return { ok: false, error: `plugin is blocked by Orca's safety list: ${blockedReason}` }
    }
    // Why the pinned release: install refuses bytes whose manifest profile differs from it.
    if (listing.release?.execution === 'trusted-worker' && !this.isFullAccessAllowed()) {
      return { ok: false, error: PLUGIN_FULL_ACCESS_OFF_ERROR }
    }
    const incompatible = this.releaseCompatibilityError(listing)
    if (incompatible) {
      return { ok: false, error: incompatible }
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
    // Why read first: the install rewrites the lock entry this comparison needs.
    const repositoryMoved = await this.isRepositoryMoved(preview.pluginKey, listing.source.url)
    const result = await installPluginFromMarketplace({
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
      ...(listing.release ? { release: listing.release } : {}),
      blockedPluginReason: this.blockedPluginReason,
      // Why also here: an unpinned listing names no execution profile to check before checkout.
      manifestError: (manifest) => fullAccessError({ manifest }, this.isFullAccessAllowed),
      ...(options.requireInstalled ? { requireInstalled: true } : {})
    })
    return result.ok && repositoryMoved ? { ...result, repositoryMoved: true } : result
  }

  private async isRepositoryMoved(pluginKey: string, nextUrl: string): Promise<boolean> {
    const entry = (await readPluginLockfile(getUserPluginsDir(this.userDataPath))).plugins[
      pluginKey
    ]
    return (
      entry?.source.kind === 'marketplace' && !isSameGitRepository(entry.source.plugin.url, nextUrl)
    )
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
    const preview = await this.preview(sourceId, pluginKey)
    return isSameGitRepository(entry.source.plugin.url, preview.source.url)
      ? preview
      : { ...preview, repositoryMoved: true }
  }

  /** The own-catalog listing an installed plugin would update from, read from caches only. */
  async findInstalledUpdateListing(pluginKey: string): Promise<{
    listing: PluginMarketplaceListing
    officialCatalog: boolean
  } | null> {
    const entry = (await readPluginLockfile(getUserPluginsDir(this.userDataPath))).plugins[
      pluginKey
    ]
    if (!entry || entry.source.kind !== 'marketplace') {
      return null
    }
    const sourceId = marketplaceSourceId({
      kind: 'git',
      url: entry.source.marketplace.url,
      ref: entry.source.marketplace.ref
    })
    const listing = await this.marketplace.findPlugin(sourceId, pluginKey)
    if (!listing) {
      return null
    }
    const source = (await this.marketplace.listSources()).find(({ id }) => id === sourceId)
    return {
      listing,
      officialCatalog: source?.official === true
    }
  }

  /** What `rollback` would restore, read only when the UI asks. */
  async rollbackVersion(pluginKey: string): Promise<string | null> {
    return isQualifiedPluginKey(pluginKey)
      ? readPluginRollbackVersion(join(getUserPluginsDir(this.userDataPath), pluginKey))
      : null
  }

  async rollback(pluginKey: string): Promise<PluginInstallResult> {
    return rollbackInstalledPlugin({
      pluginsDir: getUserPluginsDir(this.userDataPath),
      pluginKey,
      hostVersion: this.hostVersion,
      blockedPluginReason: this.blockedPluginReason
    })
  }

  /** Why cache now: the staging tree is deleted after preview, and images were already checked by
   *  the install inspection, so their hashes are the only stable names. */
  private async cachePreviewImages(
    rootDir: string,
    manifest: PluginManifest
  ): Promise<PluginHostImages | undefined> {
    const cache = this.imageCache
    if (!cache) {
      return undefined
    }
    const hashes = new Map<string, string>()
    for (const image of declaredPluginImages(manifest)) {
      const bytes = await readContainedPluginArtifactBytes(
        rootDir,
        image.path,
        PLUGIN_IMAGE_RULES[image.kind].maxBytes
      ).catch(() => null)
      const sha256 = bytes ? await cache.put(bytes) : null
      if (sha256) {
        hashes.set(image.path, sha256)
      }
    }
    return pluginManifestHostImages(manifest, (_slot, path) => {
      const sha256 = hashes.get(path)
      return sha256 ? pluginShaImageUrl(sha256) : null
    })
  }

  private releaseCompatibilityError(listing: PluginMarketplaceListing): string | null {
    return listing.release
      ? pluginCatalogReleaseCompatibilityError(listing.release, this.hostVersion)
      : null
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
