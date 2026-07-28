import {
  parsePluginIconThemeArtifact,
  sanitizePluginIconSvg,
  type PluginIconThemeArtifact,
  type PluginIconThemeImage,
  type PluginIconThemeMetadata,
  type PluginIconThemeRegistration
} from '../../shared/plugins/plugin-icon-theme-artifact'
import {
  PLUGIN_ICON_SVG_MAX_BYTES,
  PLUGIN_ICON_THEME_MAX_BYTES,
  PLUGIN_ICON_TOTAL_MAX_BYTES,
  readContainedPluginArtifactText
} from './plugin-artifact-validation'
import type { PluginContentVerifier } from './plugin-content-integrity'
import { mapWithConcurrency } from '../../shared/map-with-concurrency'
import {
  isInvalidDiscoveredPlugin,
  type DiscoveredPlugin,
  type ValidDiscoveredPlugin
} from './plugin-discovery'

const ICON_THEME_LOAD_CONCURRENCY = 4

type IconThemeLoadResult =
  | { pluginKey: string; themes: IconThemeDescriptor[] }
  | { pluginKey: string; error: string }

type IconThemeDescriptor = PluginIconThemeMetadata & {
  rootDir: string
  artifact: PluginIconThemeArtifact
}

function svgThemeImage(svg: string): PluginIconThemeImage {
  return {
    dataUrl: `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`,
    // External SVG image documents cannot inherit host currentColor. Render
    // those monochrome assets as masks so status and dark-mode colors apply.
    rendering: /\bcurrentColor\b/i.test(svg) ? 'mask' : 'image'
  }
}

export class PluginIconThemeRegistry {
  private themes: IconThemeDescriptor[] = []
  private readonly loadedThemes = new Map<string, Promise<PluginIconThemeRegistration>>()
  private readonly errors = new Map<string, string>()

  constructor(private readonly contentVerifier: PluginContentVerifier) {}

  list(): readonly PluginIconThemeMetadata[] {
    return this.themes.map(({ id, pluginKey, label }) => ({ id, pluginKey, label }))
  }

  async load(id: string): Promise<PluginIconThemeRegistration | null> {
    const descriptor = this.themes.find((theme) => theme.id === id)
    if (!descriptor) {
      return null
    }
    const existing = this.loadedThemes.get(id)
    if (existing) {
      return existing
    }
    const loading = this.materialize(descriptor)
    this.loadedThemes.set(id, loading)
    try {
      return await loading
    } catch (error) {
      this.loadedThemes.delete(id)
      throw error
    }
  }

  error(pluginKey: string): string | null {
    return this.errors.get(pluginKey) ?? null
  }

  async reconcile(
    discovered: readonly DiscoveredPlugin[],
    isApproved: (plugin: ValidDiscoveredPlugin) => boolean
  ): Promise<void> {
    const candidates = discovered.filter(
      (plugin): plugin is ValidDiscoveredPlugin =>
        !isInvalidDiscoveredPlugin(plugin) &&
        isApproved(plugin) &&
        plugin.manifest.contributes.iconThemes.length > 0
    )
    const results = await mapWithConcurrency(
      candidates,
      ICON_THEME_LOAD_CONCURRENCY,
      async (plugin): Promise<IconThemeLoadResult> => {
        try {
          await this.contentVerifier.verify(plugin)
          const themes: IconThemeDescriptor[] = []
          for (const contribution of plugin.manifest.contributes.iconThemes) {
            const artifact = parsePluginIconThemeArtifact(
              await readContainedPluginArtifactText(
                plugin.rootDir,
                contribution.path,
                PLUGIN_ICON_THEME_MAX_BYTES
              )
            )
            themes.push({
              id: `plugin:${plugin.pluginKey}/${contribution.id}`,
              pluginKey: plugin.pluginKey,
              label: contribution.label ?? contribution.id,
              rootDir: plugin.rootDir,
              artifact
            })
          }
          return { pluginKey: plugin.pluginKey, themes }
        } catch (error) {
          return {
            pluginKey: plugin.pluginKey,
            error: error instanceof Error ? error.message : String(error)
          }
        }
      }
    )
    this.themes = results.flatMap((result) => ('themes' in result ? result.themes : []))
    this.loadedThemes.clear()
    this.errors.clear()
    for (const result of results) {
      if ('error' in result) {
        this.errors.set(result.pluginKey, result.error)
      }
    }
  }

  private async materialize(descriptor: IconThemeDescriptor): Promise<PluginIconThemeRegistration> {
    const paths = new Set([
      ...Object.values(descriptor.artifact.icons),
      ...Object.values(descriptor.artifact.fileNames),
      ...Object.values(descriptor.artifact.fileExtensions)
    ])
    const dataByPath = new Map<string, PluginIconThemeImage>()
    let loadedIconBytes = 0
    for (const path of paths) {
      const svg = await readContainedPluginArtifactText(
        descriptor.rootDir,
        path,
        PLUGIN_ICON_SVG_MAX_BYTES
      )
      loadedIconBytes += Buffer.byteLength(svg, 'utf8')
      if (loadedIconBytes > PLUGIN_ICON_TOTAL_MAX_BYTES) {
        throw new Error(`icon theme SVGs exceed ${PLUGIN_ICON_TOTAL_MAX_BYTES} bytes in total`)
      }
      dataByPath.set(path, svgThemeImage(sanitizePluginIconSvg(svg)))
    }
    const mapPaths = (entries: Record<string, string>): Record<string, PluginIconThemeImage> =>
      Object.fromEntries(Object.entries(entries).map(([key, path]) => [key, dataByPath.get(path)!]))
    return {
      id: descriptor.id,
      pluginKey: descriptor.pluginKey,
      label: descriptor.label,
      icons: mapPaths(descriptor.artifact.icons),
      fileNames: mapPaths(descriptor.artifact.fileNames),
      fileExtensions: mapPaths(descriptor.artifact.fileExtensions)
    }
  }
}
