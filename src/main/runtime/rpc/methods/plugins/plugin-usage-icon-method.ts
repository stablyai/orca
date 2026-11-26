import { defineMethod } from '../../core'
import { readCheckedPluginImage } from '../../../../plugins/media/plugin-image-read'
import type { PluginService } from '../../../../plugins/plugin-service'
import { PluginReadUsageIconParams } from '../../../../../shared/rpc-contract/plugins/plugins-params'

export function pluginUsageIconMethod(requirePluginService: () => PluginService) {
  return defineMethod({
    name: 'plugins.readUsageIcon',
    permission: 'workspace',
    params: PluginReadUsageIconParams,
    handler: async ({ pluginKey, revision }): Promise<{ base64: string } | null> => {
      const service = requirePluginService()
      // The same approved revision still owns its reading during a refresh pause.
      const plugin = service.findApprovedPlugin(pluginKey, true)
      if (plugin?.manifest.manifestVersion !== 2 || !plugin.manifest.icon) {
        return null
      }
      const isPublished = () =>
        service.usageProviders
          .snapshot()
          .some((reading) => reading.pluginKey === pluginKey && reading.iconRevision === revision)
      if (!isPublished()) {
        return null
      }
      const image = await readCheckedPluginImage(
        plugin.rootDir,
        'icon',
        plugin.manifest.icon
      ).catch(() => null)
      return image && isPublished() ? { base64: image.bytes.toString('base64') } : null
    }
  })
}
