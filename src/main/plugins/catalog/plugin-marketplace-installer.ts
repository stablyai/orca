import type {
  PluginMarketplaceInstallPreview,
  PluginMarketplaceInstallResult,
  PluginMarketplacePreviewIdentity
} from './plugin-marketplace-install-types'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PluginImageCache } from '../media/plugin-image-cache'
import { cachePluginPreviewImages } from './plugin-marketplace-preview-images'
import { readPluginVmRecipeIdentities } from '../contributions/plugin-vm-recipe-identities'
import { pluginCatalogReleaseCompatibilityError } from '../../../shared/plugins/manifest/plugin-manifest-compatibility'
import { isQualifiedPluginKey } from '../../../shared/plugins/manifest/plugin-manifest'
import { getUserPluginsDir } from '../discovery/plugin-discovery'
import { readPluginRollbackVersion } from '../installation/plugin-rollback-candidate'
import { checkoutPluginGitSource } from '../installation/plugin-git-repository'
import {
  installPluginFromMarketplace,
  readPluginLockfile,
  rollbackInstalledPlugin,
  type PluginInstallResult
} from '../installation/plugin-install'
import { inspectPluginInstallTree } from '../installation/plugin-install-staging'
import {
  marketplaceInstallRefreshError,
  withMarketplaceInstallEligibility
} from './plugin-marketplace-install-eligibility'
import type {
  PluginMarketplaceListing,
  PluginMarketplaceService
} from './plugin-marketplace-service'
import { marketplaceInstallMoved, marketplaceInstallOf } from './plugin-marketplace-install-origin'
import type {
  PluginLockEntry,
  PluginLockfile
} from '../../../shared/plugins/installation/plugin-install-lockfile'
import {
  pluginInstallKind,
  trackPluginInstalled,
  type PluginInstallTrigger
} from '../../telemetry/plugin-install-telemetry'

export type {
  PluginMarketplaceInstallPreview,
  PluginMarketplaceInstallResult,
  PluginMarketplacePreviewIdentity
} from './plugin-marketplace-install-types'

export class PluginMarketplaceInstaller {
  private readonly marketplace: PluginMarketplaceService
  private readonly userDataPath: string
  private readonly hostVersion: string
  private readonly blockedPluginReason: (pluginKey: string) => string | null
  private readonly imageCache: PluginImageCache | null
  private readonly revokeConsent: (pluginKey: string) => void
  private readonly reconcileConsent: () => Promise<void>

  constructor(options: {
    marketplace: PluginMarketplaceService
    userDataPath: string
    hostVersion: string
    blockedPluginReason?: (pluginKey: string) => string | null
    imageCache?: PluginImageCache
    revokeConsent: (pluginKey: string) => void
    reconcileConsent?: () => Promise<void>
  }) {
    this.imageCache = options.imageCache ?? null
    this.revokeConsent = options.revokeConsent
    this.reconcileConsent = options.reconcileConsent ?? (() => Promise.resolve())
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
        identity: { pluginKey },
        ...(listing.release ? { release: { record: listing.release, resolvedCommit } } : {})
      })
      if (!inspection.ok) {
        throw new Error(inspection.error)
      }
      const images = await cachePluginPreviewImages(
        this.imageCache,
        stagingDirectory,
        inspection.manifest
      )
      const vmRecipeIdentities =
        inspection.manifest.contributes.vmRecipes.length > 0
          ? await readPluginVmRecipeIdentities(stagingDirectory, inspection.manifest)
          : undefined
      // Why every preview, not only updates: an install link to an installed plugin replaces it too.
      const moved = marketplaceInstallMoved(await this.readLockEntry(pluginKey), listing.source)
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
        ...(listing.managedByTeams ? { managedByTeams: listing.managedByTeams } : {}),
        bundled: listing.bundled,
        ...(listing.blockedByKillList ? { blockedByKillList: listing.blockedByKillList } : {}),
        ...(images ? { images } : {}),
        ...(vmRecipeIdentities !== undefined ? { vmRecipeIdentities } : {}),
        ...(moved ? { repositoryMoved: true as const } : {})
      }
    } finally {
      await rm(stagingDirectory, { recursive: true, force: true })
    }
  }

  async install(
    preview: PluginMarketplacePreviewIdentity,
    options: {
      requireInstalled?: boolean
      requireMissing?: boolean
      expectedInstalledContentHash?: string
      trigger?: PluginInstallTrigger
      stillAllowed?: () => boolean
    } = {}
  ): Promise<PluginMarketplaceInstallResult> {
    const sourceId = preview.marketplaceSourceId
    try {
      await this.marketplace.waitForSourceRefresh(sourceId)
    } catch (error) {
      return { ok: false, error: marketplaceInstallRefreshError(error) }
    }
    const listing = await this.marketplace.findPlugin(sourceId, preview.pluginKey)
    if (!listing || listing.marketplaceCommit !== preview.marketplaceCommit) {
      return { ok: false, error: 'marketplace changed after preview; review the plugin again' }
    }
    const blockedReason =
      listing.blockedByKillList?.reason ?? this.blockedPluginReason(preview.pluginKey)
    if (blockedReason) {
      return {
        ok: false,
        error: listing.blockedByKillList?.team
          ? blockedReason
          : `plugin is blocked by Orca's safety list: ${blockedReason}`
      }
    }
    const incompatible = this.releaseCompatibilityError(listing)
    if (incompatible) {
      return { ok: false, error: incompatible }
    }
    const sourceState = (await this.marketplace.listSources()).find(
      (source) => source.id === sourceId
    )
    if (!sourceState) {
      return { ok: false, error: 'marketplace source is no longer configured' }
    }
    let previousVersion: string | null = null
    let repositoryMoved = false
    let consentRevoked = false
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
      withPublication: (publish, previous) => {
        previousVersion = previous?.version ?? null
        repositoryMoved = marketplaceInstallMoved(previous ?? null, listing.source)
        return withMarketplaceInstallEligibility(
          this.marketplace,
          listing,
          this.hostVersion,
          () => {
            if (repositoryMoved) {
              consentRevoked = true
              this.revokeConsent(preview.pluginKey)
            }
            return publish()
          }
        )
      },
      blockedPluginReason: (key) => {
        if (
          options.stillAllowed?.() === false ||
          !this.marketplace.allowsSource(sourceState.source)
        ) {
          return 'The team plugin policy changed during installation.'
        }
        return this.blockedPluginReason(key)
      },
      ...(options.requireInstalled ? { requireInstalled: true } : {}),
      ...(options.requireMissing ? { requireMissing: true } : {}),
      ...(options.expectedInstalledContentHash
        ? { expectedInstalledContentHash: options.expectedInstalledContentHash }
        : {})
    })
    if (consentRevoked) {
      await this.reconcileConsent().catch((error) =>
        console.warn('[plugins] consent reconciliation failed:', error)
      )
    }
    if (result.ok) {
      trackPluginInstalled({
        marketplaceUrl: sourceState.source.url,
        plugin_key: result.pluginKey,
        version: result.version,
        kind: pluginInstallKind(previousVersion, result.version),
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

  async previewInstalledUpdate(pluginKey: string): Promise<PluginMarketplaceInstallPreview> {
    const installed = marketplaceInstallOf(await this.readLockEntry(pluginKey))
    if (!installed) {
      throw new Error(`plugin ${pluginKey} was not installed from a marketplace`)
    }
    return this.preview(installed.sourceId, pluginKey)
  }

  /** The own-catalog listing an installed plugin would update from, read from caches only. */
  async findInstalledUpdateListing(
    pluginKey: string,
    lock?: PluginLockfile
  ): Promise<{
    listing: PluginMarketplaceListing
    officialCatalog: boolean
  } | null> {
    const installed = marketplaceInstallOf(
      lock ? (lock.plugins[pluginKey] ?? null) : await this.readLockEntry(pluginKey)
    )
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
