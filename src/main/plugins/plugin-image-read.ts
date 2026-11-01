import {
  PLUGIN_IMAGE_MIME,
  readPluginImageHeader
} from '../../shared/plugins/images/plugin-image-format'
import {
  PLUGIN_IMAGE_RULES,
  pluginImageRuleError,
  type PluginImageKind
} from '../../shared/plugins/images/plugin-image-fields'
import { readContainedPluginArtifactBytes } from './plugin-artifact-validation'

export type CheckedPluginImage = { bytes: Buffer; mimeType: string }

/** Reads a plugin image inside its root and re-checks it against its kind's rules; null when it no longer fits. */
export async function readCheckedPluginImage(
  rootDir: string,
  kind: PluginImageKind,
  path: string
): Promise<CheckedPluginImage | null> {
  const bytes = await readContainedPluginArtifactBytes(
    rootDir,
    path,
    PLUGIN_IMAGE_RULES[kind].maxBytes
  )
  const info = readPluginImageHeader(bytes)
  if (typeof info === 'string' || pluginImageRuleError(kind, info, bytes.byteLength)) {
    return null
  }
  return { bytes, mimeType: PLUGIN_IMAGE_MIME[info.format] }
}
