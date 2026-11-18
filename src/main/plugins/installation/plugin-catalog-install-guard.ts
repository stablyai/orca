import type { PluginInstallSource } from '../../../shared/plugins/installation/plugin-install-lockfile'

/**
 * Refusal when an install would move a catalog install to another source. `catalog` is the
 * incoming install's catalog, or null for a direct Git URL or local folder.
 */
export function pluginCatalogTakeoverError(
  pluginKey: string,
  installed: PluginInstallSource | undefined,
  catalog: { url: string; ref: string } | null
): string | null {
  // Why: the lock source decides where auto-update looks, so a takeover would silently stop updates.
  if (installed?.kind !== 'marketplace') {
    return null
  }
  const from = installed.marketplace
  if (catalog && from.url === catalog.url && from.ref === catalog.ref) {
    return null
  }
  const target = catalog ? 'another catalog' : 'a Git URL or local folder'
  return `${pluginKey} is installed from ${from.url}; remove it first to install it from ${target}`
}
