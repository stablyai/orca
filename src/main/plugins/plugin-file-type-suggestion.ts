import type { PluginFileTypeSuggestionSettings } from '../../shared/plugins/plugin-file-type'
import { isInvalidDiscoveredPlugin, type DiscoveredPlugin } from './plugin-discovery'
import type { PluginMarketplaceListing } from './plugin-marketplace-projection'

export type PluginFileTypeSuggestion = {
  marketplaceSourceId: string
  pluginKey: string
  fileType: string
  /** The release's verified plugin name, when the catalog gives one. */
  name?: string
}

/**
 * The first official catalog plugin, in catalog order, that says it opens this file type. A
 * user-added marketplace never produces an unsolicited suggestion. Nothing when
 * suggestions are off or dismissed for the type, or when any installed plugin (even a disabled
 * one) already handles it, so a user never gets pointed at what they already have.
 */
export function findPluginFileTypeSuggestion(input: {
  fileType: string
  settings: PluginFileTypeSuggestionSettings & { pluginSystemEnabled?: boolean }
  listings: readonly PluginMarketplaceListing[]
  installed: readonly DiscoveredPlugin[]
}): PluginFileTypeSuggestion | null {
  const { fileType, settings } = input
  if (
    settings.pluginSystemEnabled !== true ||
    settings.pluginFileTypeSuggestions === false ||
    settings.pluginDismissedFileTypes?.includes(fileType)
  ) {
    return null
  }
  const installedKeys = new Set<string>()
  for (const plugin of input.installed) {
    if (isInvalidDiscoveredPlugin(plugin)) {
      continue
    }
    installedKeys.add(plugin.pluginKey)
    const handles = plugin.manifest.contributes.syntaxes.some((syntax) =>
      syntax.extensions.some((extension) => extension.slice(1).toLowerCase() === fileType)
    )
    if (handles) {
      return null
    }
  }
  const listing = input.listings.find(
    (candidate) =>
      candidate.official &&
      !candidate.blockedByKillList &&
      !installedKeys.has(candidate.pluginKey) &&
      candidate.release?.fileTypes?.includes(fileType)
  )
  return listing
    ? {
        marketplaceSourceId: listing.marketplaceSourceId,
        pluginKey: listing.pluginKey,
        fileType,
        ...(listing.release?.name ? { name: listing.release.name } : {})
      }
    : null
}
