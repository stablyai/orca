import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { safeRemoveOverlay } from '../pty/overlay-mirror'

export const OPENCODE_OVERLAY_MANIFEST_FILE = '.orca-opencode-overlay-manifest.json'
export type OpenCodeOverlayManifest = {
  topLevelEntries: string[]
  pluginEntries: string[]
  sourceConfigDir?: string
}

export function readOpenCodeOverlayManifest(overlayDir: string): OpenCodeOverlayManifest {
  const empty = { topLevelEntries: [], pluginEntries: [] }
  try {
    const parsed: unknown = JSON.parse(
      readFileSync(join(overlayDir, OPENCODE_OVERLAY_MANIFEST_FILE), 'utf8')
    )
    if (!parsed || typeof parsed !== 'object') {
      return empty
    }
    return {
      ...('sourceConfigDir' in parsed && typeof parsed.sourceConfigDir === 'string'
        ? { sourceConfigDir: parsed.sourceConfigDir }
        : {}),
      topLevelEntries:
        'topLevelEntries' in parsed && Array.isArray(parsed.topLevelEntries)
          ? parsed.topLevelEntries.filter((entry): entry is string => typeof entry === 'string')
          : [],
      pluginEntries:
        'pluginEntries' in parsed && Array.isArray(parsed.pluginEntries)
          ? parsed.pluginEntries.filter((entry): entry is string => typeof entry === 'string')
          : []
    }
  } catch {
    return empty
  }
}

export function writeOpenCodeOverlayManifest(
  overlayDir: string,
  manifest: OpenCodeOverlayManifest
): void {
  writeFileSync(
    join(overlayDir, OPENCODE_OVERLAY_MANIFEST_FILE),
    `${JSON.stringify(manifest, null, 2)}\n`
  )
}

export function clearOpenCodeOverlayManifestEntries(
  overlayDir: string,
  manifest: OpenCodeOverlayManifest,
  pluginFileName: string
): void {
  for (const entryName of manifest.topLevelEntries) {
    safeRemoveOverlay(join(overlayDir, entryName), overlayDir)
  }
  const overlayPluginsDir = join(overlayDir, 'plugins')
  for (const entryName of manifest.pluginEntries) {
    if (entryName === pluginFileName) {
      continue
    }
    safeRemoveOverlay(join(overlayPluginsDir, entryName), overlayPluginsDir)
  }
}
