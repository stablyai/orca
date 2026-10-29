import type { PluginThemeContribution } from '../../../shared/plugins/contributions/plugin-content-pack-contributions'
import {
  PLUGIN_ICON_SVG_MAX_BYTES,
  isPlausiblePluginIconSvg,
  parsePluginIconThemeArtifact,
  type PluginIconThemeArtifact,
  type PluginIconThemeMetadata,
  type PluginIconThemeRegistration
} from '../../../shared/plugins/artifacts/plugin-icon-theme-artifact'
import {
  PLUGIN_ICON_THEME_MAX_BYTES,
  readContainedPluginArtifactText
} from '../plugin-artifact-validation'
import { PluginArtifactPackRegistry } from './plugin-artifact-pack-registry'
import type { PluginContentVerifier } from '../plugin-content-integrity'
import type { DiscoveredPlugin, ValidDiscoveredPlugin } from '../plugin-discovery'

const ICON_THEME_TOTAL_SVG_MAX_BYTES = 4 * 1024 * 1024

type IconThemeDescriptor = PluginIconThemeMetadata & {
  rootDir: string
  artifact: PluginIconThemeArtifact
}

/** Lists icon themes cheaply and reads one theme's SVGs only when it is selected. */
export class PluginIconThemeRegistry {
  private readonly descriptors: PluginArtifactPackRegistry<
    PluginThemeContribution,
    IconThemeDescriptor
  >
  private readonly loaded = new Map<string, Promise<PluginIconThemeRegistration>>()

  constructor(contentVerifier: PluginContentVerifier) {
    this.descriptors = new PluginArtifactPackRegistry({
      contentVerifier,
      contributions: (plugin) => plugin.manifest.contributes.iconThemes,
      load: async (plugin, contribution) => ({
        id: `plugin:${plugin.pluginKey}/${contribution.id}`,
        pluginKey: plugin.pluginKey,
        label: contribution.title,
        rootDir: plugin.rootDir,
        artifact: parsePluginIconThemeArtifact(
          await readContainedPluginArtifactText(
            plugin.rootDir,
            contribution.path,
            PLUGIN_ICON_THEME_MAX_BYTES
          )
        )
      })
    })
  }

  list(): PluginIconThemeMetadata[] {
    return this.descriptors.list().map(({ id, pluginKey, label }) => ({ id, pluginKey, label }))
  }

  error(pluginKey: string): string | null {
    return this.descriptors.error(pluginKey)
  }

  async reconcile(
    discovered: readonly DiscoveredPlugin[],
    isApproved: (plugin: ValidDiscoveredPlugin) => boolean
  ): Promise<void> {
    await this.descriptors.reconcile(discovered, isApproved)
    this.loaded.clear()
  }

  async load(id: string): Promise<PluginIconThemeRegistration | null> {
    const descriptor = this.descriptors.list().find((theme) => theme.id === id)
    if (!descriptor) {
      return null
    }
    let loading = this.loaded.get(id)
    if (!loading) {
      loading = materialize(descriptor)
      this.loaded.set(id, loading)
      void loading.catch(() => this.loaded.delete(id))
    }
    return loading
  }
}

async function materialize(descriptor: IconThemeDescriptor): Promise<PluginIconThemeRegistration> {
  const { artifact } = descriptor
  const paths = [
    ...new Set([
      ...Object.values(artifact.icons),
      ...Object.values(artifact.fileNames),
      ...Object.values(artifact.fileExtensions)
    ])
  ]
  const svgs: string[] = []
  let totalBytes = 0
  for (const path of paths) {
    const svg = await readContainedPluginArtifactText(
      descriptor.rootDir,
      path,
      PLUGIN_ICON_SVG_MAX_BYTES
    )
    totalBytes += Buffer.byteLength(svg, 'utf8')
    if (totalBytes > ICON_THEME_TOTAL_SVG_MAX_BYTES) {
      throw new Error(`icon theme SVGs exceed ${ICON_THEME_TOTAL_SVG_MAX_BYTES} bytes in total`)
    }
    if (!isPlausiblePluginIconSvg(svg)) {
      throw new Error(`${path}: not a single SVG document`)
    }
    svgs.push(svg)
  }
  const indexOf = (entries: Record<string, string>): Record<string, number> =>
    Object.fromEntries(Object.entries(entries).map(([key, path]) => [key, paths.indexOf(path)]))
  return {
    id: descriptor.id,
    pluginKey: descriptor.pluginKey,
    label: descriptor.label,
    svgs,
    icons: indexOf(artifact.icons),
    fileNames: indexOf(artifact.fileNames),
    fileExtensions: indexOf(artifact.fileExtensions)
  }
}
