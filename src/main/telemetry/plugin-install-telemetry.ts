/**
 * Install and uninstall rows for plugins from Orca's public catalogs, which feed the directory's
 * install counts. Anything else (private catalogs, git, local and dev installs) never reports.
 */
import { COMMUNITY_MARKETPLACE_GIT_SOURCE } from '../../shared/plugins/catalog/plugin-install-link'
import {
  isOfficialMarketplaceGitSource,
  isSameGitRepository
} from '../../shared/plugins/catalog/plugin-marketplace'
import type { PluginInstallSource } from '../../shared/plugins/installation/plugin-install-lockfile'
import type { EventProps } from '../../shared/telemetry-events'
import { track } from './client'

export type PluginInstallTelemetryProps = EventProps<'plugin_installed'>
export type PluginInstallTrigger = PluginInstallTelemetryProps['trigger']
type Catalog = PluginInstallTelemetryProps['catalog']

/** The public catalog a marketplace URL names, or null for any other catalog. */
export function pluginTelemetryCatalog(marketplaceUrl: string): Catalog | null {
  if (isOfficialMarketplaceGitSource(marketplaceUrl)) {
    return 'official'
  }
  return isSameGitRepository(marketplaceUrl, COMMUNITY_MARKETPLACE_GIT_SOURCE.url)
    ? 'community'
    : null
}

export function pluginInstallKind(
  priorVersion: string | null,
  version: string
): PluginInstallTelemetryProps['kind'] {
  if (priorVersion === null) {
    return 'install'
  }
  return priorVersion === version ? 'reinstall' : 'update'
}

export function trackPluginInstalled(
  input: Omit<PluginInstallTelemetryProps, 'catalog'> & { marketplaceUrl: string }
): void {
  const { marketplaceUrl, ...rest } = input
  const catalog = pluginTelemetryCatalog(marketplaceUrl)
  if (catalog) {
    safeTrack(() => track('plugin_installed', { ...rest, catalog }))
  }
}

/** Reports only when the removed plugin came from a public catalog. */
export function trackPluginUninstalled(
  pluginKey: string,
  source: PluginInstallSource | undefined
): void {
  const catalog =
    source?.kind === 'marketplace' ? pluginTelemetryCatalog(source.marketplace.url) : null
  if (catalog) {
    safeTrack(() => track('plugin_uninstalled', { plugin_key: pluginKey, catalog }))
  }
}

function safeTrack(emit: () => void): void {
  try {
    // track() applies the consent gate and validates against the strict schema.
    emit()
  } catch {
    // Telemetry never costs an install.
  }
}
