import { isDeepStrictEqual } from 'node:util'
import { ORCA_CLOUD_TEAM_POLICY_FLAGS as flags } from '../../../shared/orca-profiles/orca-cloud-team-policy'
import { marketplaceSourceId } from './plugin-marketplace-store'
import type { PluginMarketplaceInstaller } from './plugin-marketplace-installer'
import type { PluginMarketplaceService } from './plugin-marketplace-service'
import type { PluginService } from '../plugin-service'
import {
  getActiveTeamCapabilities,
  getActiveTeamProfileScope
} from '../../orca-profiles/cloud-auth/active-team-capabilities'
import { getRequiredTeamPlugins } from '../installation/plugin-team-install-policy'
import { enableIfDataPlugin } from './plugin-one-click-enable'

export type ApproveRequiredPlugin = (
  pluginKey: string,
  fingerprint: string,
  stillRequired: () => boolean
) => Promise<void>

export async function installRequiredTeamPlugins(
  marketplace: PluginMarketplaceService,
  installer: PluginMarketplaceInstaller,
  plugins: PluginService,
  refreshStaleCatalogs: () => Promise<void>,
  approve: ApproveRequiredPlugin
): Promise<void> {
  const capabilities = getActiveTeamCapabilities()
  const policy = capabilities?.teamPolicy
  const required = getRequiredTeamPlugins()
  if (!policy || !required?.length) {
    return
  }
  const scope = getActiveTeamProfileScope()
  const stillRequired = (pluginKey: string): boolean => {
    const current = getActiveTeamCapabilities()
    return Boolean(
      getRequiredTeamPlugins()?.includes(pluginKey) &&
      isDeepStrictEqual(current?.teamPolicy?.orgIds, policy.orgIds) &&
      isDeepStrictEqual(current?.teamPolicy?.internalCatalogs, policy.internalCatalogs) &&
      current?.flags[flags.officialPlugins] === capabilities?.flags[flags.officialPlugins] &&
      current?.flags[flags.communityPlugins] === capabilities?.flags[flags.communityPlugins] &&
      isDeepStrictEqual(getActiveTeamProfileScope(), scope)
    )
  }
  const lock = await installer.readInstallLockfile()
  const missing = required.filter((pluginKey) => !lock.plugins[pluginKey])
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
  const installed = new Map<string, string>()
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
    const allowed = (): boolean => stillRequired(pluginKey)
    try {
      // Catalog v2 already pins the commit. The installer still checks the tree and release.
      const preview = listing.release
        ? { ...listing, resolvedCommit: listing.release.commit }
        : await installer.preview(listing.marketplaceSourceId, pluginKey)
      if (allowed()) {
        const result = await installer.install(preview, {
          requireMissing: true,
          stillAllowed: allowed
        })
        if (result.ok) {
          installed.set(pluginKey, result.consentFingerprint)
        }
      }
    } catch (error) {
      console.warn(`[plugins] could not install required plugin ${pluginKey}:`, error)
    }
  }
  if (installed.size === 0) {
    return
  }
  await plugins.refresh()
  for (const [pluginKey, installedFingerprint] of installed) {
    if (!stillRequired(pluginKey)) {
      continue
    }
    await enableIfDataPlugin({
      pluginKey,
      installedFingerprint,
      findValidPlugin: (key) => plugins.findValidPlugin(key),
      approve: (key, fingerprint) => approve(key, fingerprint, () => stillRequired(key))
    }).catch((error) =>
      console.warn(`[plugins] could not enable required plugin ${pluginKey}:`, error)
    )
  }
}
