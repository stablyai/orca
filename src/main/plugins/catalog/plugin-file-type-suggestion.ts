import {
  pluginEditorFileTypes,
  pluginHandledFileTypes,
  type PluginFileTypeSuggestionPurpose,
  type PluginFileTypeSuggestionSettings
} from '../../../shared/plugins/contributions/plugin-file-type'
import { isInvalidDiscoveredPlugin, type DiscoveredPlugin } from '../plugin-discovery'
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
 * one) already handles it, so a user never gets pointed at what they already have. With the
 * `editor` purpose, for a file Orca already opens as text, only a custom editor counts.
 */
export function findPluginFileTypeSuggestion(input: {
  fileType: string
  purpose?: PluginFileTypeSuggestionPurpose
  settings: PluginFileTypeSuggestionSettings & { pluginSystemEnabled?: boolean }
  listings: readonly PluginMarketplaceListing[]
  installed: readonly DiscoveredPlugin[]
}): PluginFileTypeSuggestion | null {
  const { fileType, settings } = input
  const editorOnly = input.purpose === 'editor'
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
    const handled = editorOnly
      ? pluginEditorFileTypes(plugin.manifest.contributes)
      : pluginHandledFileTypes(plugin.manifest.contributes)
    if (handled.includes(fileType)) {
      return null
    }
  }
  const listing = input.listings.find(
    (candidate) =>
      candidate.official &&
      !candidate.blockedByKillList &&
      !installedKeys.has(candidate.pluginKey) &&
      candidate.release?.fileTypes?.includes(fileType) &&
      (!editorOnly || candidate.release?.editorFileTypes?.includes(fileType))
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
