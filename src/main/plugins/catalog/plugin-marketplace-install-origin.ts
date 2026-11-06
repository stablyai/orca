import type {
  PluginInstallSource,
  PluginLockEntry
} from '../../../shared/plugins/installation/plugin-install-lockfile'
import { marketplaceSourceId } from './plugin-marketplace-store'

type MarketplaceInstallSource = Extract<PluginInstallSource, { kind: 'marketplace' }>
export type MarketplaceInstall = { sourceId: string; plugin: MarketplaceInstallSource['plugin'] }

/** The catalog a lock entry was installed from, or null when it was not a marketplace install. */
export function marketplaceInstallOf(entry: PluginLockEntry | null): MarketplaceInstall | null {
  if (entry?.source.kind !== 'marketplace') {
    return null
  }
  const { marketplace, plugin } = entry.source
  return {
    sourceId: marketplaceSourceId({ kind: 'git', url: marketplace.url, ref: marketplace.ref }),
    plugin
  }
}
