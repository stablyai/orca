import type { PluginManifest } from '../../shared/plugins/manifest/plugin-manifest'
import {
  PLUGIN_FONT_FILE_MAX_BYTES,
  PLUGIN_FONT_MIME,
  PLUGIN_FONTS_TOTAL_MAX_BYTES,
  parsePluginFontSlot,
  pluginFontFormat
} from '../../shared/plugins/contributions/plugin-font-contribution'
import { readContainedPluginArtifactBytes } from './plugin-contained-artifact'

export type CheckedPluginFont = { bytes: Buffer; mimeType: string }

// Why main never parses a font: only the signature is checked here; the renderer's font loader
// sanitizes the file before anything reads its tables.
async function readCheckedFont(rootDir: string, path: string): Promise<CheckedPluginFont> {
  const bytes = await readContainedPluginArtifactBytes(rootDir, path, PLUGIN_FONT_FILE_MAX_BYTES)
  const format = pluginFontFormat(path, bytes)
  if (!format) {
    throw new Error('is not a WOFF or WOFF2 font matching its extension')
  }
  return { bytes, mimeType: PLUGIN_FONT_MIME[format] }
}

/** The font file a `font-<family>-<face>` slot names, re-checked like at install; null when it no longer fits. */
export async function readPluginFontSlot(
  rootDir: string,
  manifest: PluginManifest,
  slot: string
): Promise<CheckedPluginFont | null> {
  const indexes = parsePluginFontSlot(slot)
  const face = indexes
    ? manifest.contributes.fonts[indexes.familyIndex]?.faces[indexes.faceIndex]
    : undefined
  return face ? readCheckedFont(rootDir, face.path).catch(() => null) : null
}

/** Checks every declared font file's signature and the plugin's font total at the install boundary. */
export async function validatePluginFontArtifacts(
  rootDir: string,
  manifest: PluginManifest
): Promise<{ ok: true } | { ok: false; error: string }> {
  let total = 0
  const counted = new Set<string>()
  for (const font of manifest.contributes.fonts) {
    for (const face of font.faces) {
      if (counted.has(face.path)) {
        continue
      }
      counted.add(face.path)
      try {
        total += (await readCheckedFont(rootDir, face.path)).bytes.byteLength
      } catch (error) {
        return {
          ok: false,
          error: `font "${font.family}" ${face.path}: ${error instanceof Error ? error.message : String(error)}`
        }
      }
    }
  }
  return total > PLUGIN_FONTS_TOTAL_MAX_BYTES
    ? { ok: false, error: `fonts total more than ${PLUGIN_FONTS_TOTAL_MAX_BYTES / 1024 / 1024} MB` }
    : { ok: true }
}
