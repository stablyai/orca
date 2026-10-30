import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PluginManifest } from '../../../shared/plugins/manifest/plugin-manifest'
import { PLUGIN_IMAGE_RULES } from '../../../shared/plugins/images/plugin-image-fields'
import {
  pluginShaImageUrl,
  type PluginHostImages
} from '../../../shared/plugins/images/plugin-image-url'
import { readContainedPluginArtifactBytes } from '../plugin-artifact-validation'
import { declaredPluginImages } from '../plugin-image-artifact-validation'
import type { PluginImageCache } from '../plugin-image-cache'
import { pluginManifestHostImages } from '../plugin-manifest-images'
import { readPluginVmRecipeIdentities } from '../plugin-vm-recipe-identities'
import type { PluginVmRecipeIdentities } from '../../../shared/plugins/approval/plugin-update-access-growth'
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
import { marketplaceInstallOf, type MarketplaceInstall } from './plugin-marketplace-install-origin'
import { isSamePluginSource } from '../../../shared/plugins/catalog/plugin-marketplace'
import type {
  PluginLockEntry,
  PluginLockfile
} from '../../../shared/plugins/installation/plugin-install-lockfile'
import {
  pluginInstallKind,
  trackPluginInstalled,
  type PluginInstallTrigger
} from '../../telemetry/plugin-install-telemetry'

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
  /** What each recipe file can run, read before the staging tree is deleted; null if unreadable. */
  vmRecipeIdentities?: PluginVmRecipeIdentities
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
  private readonly imageCache: PluginImageCache | null

  constructor(options: {
    marketplace: PluginMarketplaceService
    userDataPath: string
    hostVersion: string
    blockedPluginReason?: (pluginKey: string) => string | null
    imageCache?: PluginImageCache
  }) {
    this.imageCache = options.imageCache ?? null
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
        ...(listing.source.path ? { path: listing.source.path } : {}),
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
      const vmRecipeIdentities =
        inspection.manifest.contributes.vmRecipes.length > 0
          ? await readPluginVmRecipeIdentities(stagingDirectory, inspection.manifest)
          : undefined
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
        ...(images ? { images } : {}),
        ...(vmRecipeIdentities !== undefined ? { vmRecipeIdentities } : {})
      }
    } finally {
      await rm(stagingDirectory, { recursive: true, force: true })
    }
  }

  async install(
    preview: PluginMarketplacePreviewIdentity,
    options: { requireInstalled?: boolean; trigger?: PluginInstallTrigger } = {}
  ): Promise<PluginMarketplaceInstallResult> {
    const listing = await this.requireListing(preview.marketplaceSourceId, preview.pluginKey)
    const blockedReason =
      listing.blockedByKillList?.reason ?? this.blockedPluginReason(preview.pluginKey)
    if (blockedReason) {
      return { ok: false, error: `plugin is blocked by Orca's safety list: ${blockedReason}` }
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
    const priorEntry = await this.readLockEntry(preview.pluginKey)
    const installed = marketplaceInstallOf(priorEntry)
    const repositoryMoved =
      installed !== null && !isSamePluginSource(installed.plugin, listing.source)
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
      plugin: {
        url: listing.source.url,
        ref: listing.source.ref,
        ...(listing.source.path ? { path: listing.source.path } : {})
      },
      ...(listing.release ? { release: listing.release } : {}),
      blockedPluginReason: this.blockedPluginReason,
      ...(options.requireInstalled ? { requireInstalled: true } : {})
    })
    if (result.ok) {
      trackPluginInstalled({
        marketplaceUrl: sourceState.source.url,
        plugin_key: result.pluginKey,
        version: result.version,
        kind: pluginInstallKind(priorEntry?.version ?? null, result.version),
        trigger: options.trigger ?? 'catalog'
      })
    }
    return result.ok && repositoryMoved ? { ...result, repositoryMoved: true } : result
  }

  /** Why: one read lets a pass over every plugin skip a full lockfile recovery per plugin. */
  readInstallLockfile(): Promise<PluginLockfile> {
    return readPluginLockfile(getUserPluginsDir(this.userDataPath))
  }

  private async readLockEntry(pluginKey: string): Promise<PluginLockEntry | null> {
    return (await this.readInstallLockfile()).plugins[pluginKey] ?? null
  }

  /** The catalog an installed plugin came from, or null when it was not a marketplace install. */
  private async readMarketplaceInstall(
    pluginKey: string,
    lock?: PluginLockfile
  ): Promise<MarketplaceInstall | null> {
    return marketplaceInstallOf(
      lock ? (lock.plugins[pluginKey] ?? null) : await this.readLockEntry(pluginKey)
    )
  }

  async previewInstalledUpdate(pluginKey: string): Promise<PluginMarketplaceInstallPreview> {
    const installed = await this.readMarketplaceInstall(pluginKey)
    if (!installed) {
      throw new Error(`plugin ${pluginKey} was not installed from a marketplace`)
    }
    const preview = await this.preview(installed.sourceId, pluginKey)
    return isSamePluginSource(installed.plugin, preview.source)
      ? preview
      : { ...preview, repositoryMoved: true }
  }

  /** The own-catalog listing an installed plugin would update from, read from caches only. */
  async findInstalledUpdateListing(
    pluginKey: string,
    lock?: PluginLockfile
  ): Promise<{
    listing: PluginMarketplaceListing
    officialCatalog: boolean
  } | null> {
    const installed = await this.readMarketplaceInstall(pluginKey, lock)
    const listing = installed
      ? await this.marketplace.findPlugin(installed.sourceId, pluginKey)
      : null
    if (!installed || !listing) {
      return null
    }
    const source = (await this.marketplace.listSources()).find(
      ({ id }) => id === installed.sourceId
    )
    return { listing, officialCatalog: source?.official === true }
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
      // A cache failure only costs the image; it must never fail the preview or update.
      const sha256 = bytes
        ? await cache.put(bytes).catch((error: unknown) => {
            console.warn(`[plugins] could not cache image ${image.path}:`, error)
            return null
          })
        : null
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
