import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export const OPENCODE_OVERLAY_MANIFEST_FILE = '.orca-opencode-overlay-manifest.json'
export type OpenCodeOverlayManifest = { topLevelEntries: string[]; pluginEntries: string[] }

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
