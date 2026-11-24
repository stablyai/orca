import type { PluginBlockNotice } from '../../../shared/plugins/catalog/plugin-kill-list'
import type { PluginManifest } from '../../../shared/plugins/manifest/plugin-manifest'
import type { PluginHostImages } from '../../../shared/plugins/images/plugin-image-url'
import type { PluginVmRecipeIdentities } from '../../../shared/plugins/approval/plugin-update-access-growth'
import type { PluginInstallResult } from '../installation/plugin-install'
import type { PluginMarketplaceListing } from './plugin-marketplace-projection'

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
  managedByTeams?: string[]
  bundled: boolean
  blockedByKillList?: PluginBlockNotice
  /** The manifest's images, verified at preview and cached by hash. */
  images?: PluginHostImages
  /** What each recipe file can run, read before the staging tree is deleted; null if unreadable. */
  vmRecipeIdentities?: PluginVmRecipeIdentities
  /** The catalog now points at a different repository than the installed copy came from. */
  repositoryMoved?: true
}

/** `repositoryMoved`: this replaced an install that came from a different repository. */
export type PluginMarketplaceInstallResult = PluginInstallResult & { repositoryMoved?: true }

export type PluginMarketplacePreviewIdentity = Pick<
  PluginMarketplaceInstallPreview,
  'marketplaceSourceId' | 'marketplaceCommit' | 'pluginKey' | 'resolvedCommit'
>
