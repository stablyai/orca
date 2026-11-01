import {
  pluginCatalogReleaseForHead,
  type PluginCatalogReleaseReport
} from '../../main/plugins/plugin-authoring-checks'
import type { PluginValidationReport } from './plugin-folder-validation'

export type PluginReleaseEntryResult = PluginCatalogReleaseReport & {
  path: string
  pluginKey?: string
}

/** Release entry for a plugin folder that already passed `validatePluginTarget`. */
export async function pluginReleaseEntryForFolder(
  report: PluginValidationReport
): Promise<PluginReleaseEntryResult> {
  return {
    path: report.path,
    ...(report.plugin ? { pluginKey: report.plugin.pluginKey } : {}),
    ...(await pluginCatalogReleaseForHead(report.path))
  }
}

/** Same layout as `pnpm validate:plugin`, so either output can be pasted into a catalog. */
export function formatPluginReleaseEntry(result: PluginReleaseEntryResult): string {
  return [
    ...(result.sourcePath
      ? [
          `Catalog source path (set "path" in this plugin's "source"): ${JSON.stringify(result.sourcePath)}`,
          ''
        ]
      : []),
    ...(result.entry
      ? [
          'Catalog release entry for HEAD (newest first in "releases"):',
          JSON.stringify(result.entry, null, 2)
        ]
      : []),
    ...(result.note ? [`note: ${result.note}`] : []),
    ...(result.ownerWarning ? [`warning: ${result.ownerWarning}`] : [])
  ].join('\n')
}
