import { isDeepStrictEqual } from 'node:util'
import { marketplaceSourceId } from './plugin-marketplace-store'
import type { PluginMarketplaceInstaller } from './plugin-marketplace-installer'
import type { PluginMarketplaceService } from './plugin-marketplace-service'
import type { PluginService } from '../plugin-service'
import { getActiveTeamCapabilities } from '../../orca-profiles/cloud-auth/active-team-capabilities'

export async function installRequiredTeamPlugins(
  marketplace: PluginMarketplaceService,
  installer: PluginMarketplaceInstaller,
  plugins: PluginService,
  refreshStaleCatalogs: () => Promise<void>
): Promise<void> {
  const policy = getActiveTeamCapabilities()?.teamPolicy
  if (!policy?.requiredPlugins?.length) {
    return
  }
  const stillRequired = (pluginKey: string): boolean => {
    const current = getActiveTeamCapabilities()?.teamPolicy
    return Boolean(
      current?.requiredPlugins?.includes(pluginKey) &&
      isDeepStrictEqual(current.orgIds, policy.orgIds)
    )
  }
  const lock = await installer.readInstallLockfile()
  const missing = policy.requiredPlugins.filter((pluginKey) => !lock.plugins[pluginKey])
  if (missing.length === 0) {
    return
  }
  if (!missing.some(stillRequired)) {
    return
  }
  const keys = new Set(missing)
  let listings = await marketplace.listCachedPlugins(keys)
  const listedKeys = new Set(listings.map(({ pluginKey }) => pluginKey))
  if (missing.some((key) => !listedKeys.has(key))) {
    await Promise.allSettled([marketplace.seedOfficialSource(), marketplace.seedCommunitySource()])
    await refreshStaleCatalogs()
    listings = await marketplace.listCachedPlugins(keys)
  }
  const internalIds = new Set(policy.internalCatalogs?.map(marketplaceSourceId))
  let installed = false
  for (const pluginKey of missing) {
    if (!stillRequired(pluginKey)) {
      continue
    }
    const matches = listings.filter((listing) => listing.pluginKey === pluginKey)
    const internalMatches = matches.filter((entry) => internalIds.has(entry.marketplaceSourceId))
    const listing =
      internalMatches.length > 0
        ? internalMatches.length === 1
          ? internalMatches[0]
          : undefined
        : (matches.find((entry) => entry.official) ??
          (matches.length === 1 ? matches[0] : undefined))
    if (!listing) {
      continue
    }
    try {
      // Catalog v2 already pins the commit. The installer still checks the tree and release.
      const preview = listing.release
        ? { ...listing, resolvedCommit: listing.release.commit }
        : await installer.preview(listing.marketplaceSourceId, pluginKey)
      if (stillRequired(pluginKey)) {
        const result = await installer.install(preview, {
          requireMissing: true,
          stillAllowed: () => stillRequired(pluginKey)
        })
        installed ||= result.ok
      }
    } catch (error) {
      console.warn(`[plugins] could not install required plugin ${pluginKey}:`, error)
    }
  }
  if (installed) {
    await plugins.refresh()
  }
}
