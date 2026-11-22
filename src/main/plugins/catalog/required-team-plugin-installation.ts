import { marketplaceSourceId } from './plugin-marketplace-store'
import type { PluginMarketplaceInstaller } from './plugin-marketplace-installer'
import type { PluginMarketplaceService } from './plugin-marketplace-service'
import type { PluginService } from '../plugin-service'
import { getActiveTeamCapabilities } from '../../orca-profiles/cloud-auth/active-team-capabilities'

export async function installRequiredTeamPlugins(
  marketplace: PluginMarketplaceService,
  installer: PluginMarketplaceInstaller,
  plugins: PluginService
): Promise<void> {
  const policy = getActiveTeamCapabilities()?.teamPolicy
  if (!policy?.requiredPlugins?.length) {
    return
  }
  const stillRequired = (pluginKey: string): boolean => {
    const current = getActiveTeamCapabilities()?.teamPolicy
    return Boolean(current?.orgId === policy.orgId && current.requiredPlugins?.includes(pluginKey))
  }
  const lock = await installer.readInstallLockfile()
  const missing = policy.requiredPlugins.filter((pluginKey) => !lock.plugins[pluginKey])
  if (missing.length === 0) {
    return
  }
  await Promise.allSettled([marketplace.seedOfficialSource(), marketplace.seedCommunitySource()])
  const sources = await marketplace.listSources()
  await Promise.allSettled(
    sources.filter(({ marketplace }) => !marketplace).map(({ id }) => marketplace.refreshSource(id))
  )
  const listings = await marketplace.listCachedPlugins()
  const internalId = policy.internalCatalog && marketplaceSourceId(policy.internalCatalog)
  let installed = false
  for (const pluginKey of missing) {
    if (!stillRequired(pluginKey)) {
      continue
    }
    const matches = listings.filter((listing) => listing.pluginKey === pluginKey)
    const listing =
      matches.find((entry) => entry.marketplaceSourceId === internalId) ??
      matches.find((entry) => entry.official) ??
      (matches.length === 1 ? matches[0] : undefined)
    if (!listing) {
      continue
    }
    try {
      const preview = await installer.preview(listing.marketplaceSourceId, pluginKey)
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
