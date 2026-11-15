import type { PluginManifest } from '../../../shared/plugins/manifest/plugin-manifest'
import {
  PLUGIN_PANEL_ICON_FILE_MAX_BYTES,
  pluginPanelIconFileError,
  pluginPanelIconKind
} from '../../../shared/plugins/contributions/plugin-panel-icon'
import { readContainedPluginArtifactBytes } from '../artifacts/plugin-contained-artifact'

export type DeclaredPluginPanelIcon = {
  panelIndex: number
  path: string
  slot: string
}

/** Panel icons that name a file, with the stable image-protocol slot for each panel. */
export function declaredPluginPanelIcons(manifest: PluginManifest): DeclaredPluginPanelIcon[] {
  if (manifest.manifestVersion !== 2) {
    return []
  }
  return manifest.contributes.panels.flatMap((panel, index) => {
    if (panel.icon === undefined || pluginPanelIconKind(panel.icon) !== 'file') {
      return []
    }
    return [{ panelIndex: index, path: panel.icon, slot: `panel-icon-${index}` }]
  })
}

/** Invalid panel icons fall back to `plug`, so report them without blocking the plugin. */
export async function pluginPanelIconWarnings(
  rootDir: string,
  manifest: PluginManifest
): Promise<string[]> {
  const warnings: string[] = []
  for (const icon of declaredPluginPanelIcons(manifest)) {
    try {
      const bytes = await readContainedPluginArtifactBytes(
        rootDir,
        icon.path,
        PLUGIN_PANEL_ICON_FILE_MAX_BYTES
      )
      const error = pluginPanelIconFileError(icon.path, bytes)
      if (error) {
        throw new Error(error)
      }
    } catch (error) {
      warnings.push(
        `contributes.panels[${icon.panelIndex}].icon (${icon.path}): ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }
  return warnings
}

export type CheckedPluginPanelIcon = { bytes: Buffer; mimeType: string }

/** Re-checks an installed panel icon on every image-protocol read. */
export async function readCheckedPluginPanelIcon(
  rootDir: string,
  path: string
): Promise<CheckedPluginPanelIcon | null> {
  try {
    const bytes = await readContainedPluginArtifactBytes(
      rootDir,
      path,
      PLUGIN_PANEL_ICON_FILE_MAX_BYTES
    )
    if (pluginPanelIconFileError(path, bytes)) {
      return null
    }
    return {
      bytes,
      mimeType: 'image/svg+xml'
    }
  } catch {
    return null
  }
}
