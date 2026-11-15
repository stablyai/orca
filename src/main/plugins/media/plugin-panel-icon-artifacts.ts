import type { PluginManifest } from '../../../shared/plugins/manifest/plugin-manifest'
import {
  PLUGIN_PANEL_ICON_FILE_MAX_BYTES,
  pluginPanelIconFileError,
  pluginPanelIconFileFormat,
  pluginPanelIconKind,
  type PluginPanelIconFileFormat
} from '../../../shared/plugins/contributions/plugin-panel-icon'
import { readContainedPluginArtifactBytes } from '../artifacts/plugin-contained-artifact'

export type DeclaredPluginPanelIcon = {
  path: string
  slot: string
  format: PluginPanelIconFileFormat
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
    const format = pluginPanelIconFileFormat(panel.icon)
    return format ? [{ path: panel.icon, slot: `panel-icon-${index}`, format }] : []
  })
}

/** Validates each panel icon image by its extension and bytes before install. */
export async function validatePluginPanelIconArtifacts(
  rootDir: string,
  manifest: PluginManifest
): Promise<{ ok: true } | { ok: false; error: string }> {
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
      return {
        ok: false,
        error: `panel icon ${icon.path}: ${error instanceof Error ? error.message : String(error)}`
      }
    }
  }
  return { ok: true }
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
      mimeType: pluginPanelIconFileFormat(path) === 'svg' ? 'image/svg+xml' : 'image/png'
    }
  } catch {
    return null
  }
}
