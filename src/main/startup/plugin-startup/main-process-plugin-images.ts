import { allowsTeamCatalogSource } from '../../plugins/catalog/plugin-marketplace-team-policy'
import { getActiveTeamCapabilities } from '../../orca-profiles/cloud-auth/active-team-capabilities'
import { join } from 'node:path'
import { PluginImageCache } from '../../plugins/media/plugin-image-cache'
import { PluginCatalogImageOnDemand } from '../../plugins/media/plugin-catalog-image-on-demand'
import {
  installPluginImageProtocolHandler,
  type PluginImageProtocolDependencies
} from '../../plugins/media/plugin-image-protocol'
import { PluginMarketplaceStore } from '../../plugins/catalog/plugin-marketplace-store'
import { PluginCatalogRepositoryStore } from '../../plugins/catalog/plugin-catalog-repository'
import { getPluginsDataDir } from '../../plugins/discovery/plugin-discovery'

export function createMainProcessPluginImages(
  options: Pick<PluginImageProtocolDependencies, 'findValidPlugin' | 'findApprovedPlugin'> & {
    userDataPath: string
  }
) {
  const pluginsDataDir = getPluginsDataDir(options.userDataPath)
  const imageCache = new PluginImageCache(join(pluginsDataDir, 'image-cache'))
  const store = new PluginMarketplaceStore(pluginsDataDir)
  const repositories = new PluginCatalogRepositoryStore(pluginsDataDir)
  const images = new PluginCatalogImageOnDemand({
    cache: imageCache,
    store,
    repositories,
    allowsSource: ({ source }) => allowsTeamCatalogSource(source, getActiveTeamCapabilities())
  })
  installPluginImageProtocolHandler({
    cache: imageCache,
    readCatalogImage: (reference, signal) => images.read(reference, signal),
    findValidPlugin: options.findValidPlugin,
    findApprovedPlugin: options.findApprovedPlugin
  })
  return { imageCache, store, repositories }
}
