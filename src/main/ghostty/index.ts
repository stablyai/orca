import { readFile } from 'fs/promises'
import type { GlobalSettings } from '../../shared/types'
import type { Store } from '../persistence'
import { findGhosttyConfigPath } from './discovery'
import { parseGhosttyConfig } from './parser'
import { mapGhosttyToOrca, type GhosttyImportPreview } from './mapper'

export async function previewGhosttyImport(store: Store): Promise<GhosttyImportPreview> {
  const configPath = await findGhosttyConfigPath()
  if (!configPath) {
    return { found: false, diff: {}, unsupportedKeys: [] }
  }

  const content = await readFile(configPath, 'utf-8')
  const parsed = parseGhosttyConfig(content)
  const { diff: rawDiff, unsupportedKeys } = mapGhosttyToOrca(parsed)

  const currentSettings = store.getSettings()
  const actualDiff: Partial<typeof rawDiff> = {}
  for (const key of Object.keys(rawDiff) as (keyof typeof rawDiff)[]) {
    const value = rawDiff[key]
    if (value !== undefined && currentSettings[key] !== value) {
      // Why: TypeScript's strict assignment checking for Partial<T>[K] requires
      // a cast because GlobalSettings has no index signature.
      ;(actualDiff as Record<string, GlobalSettings[keyof GlobalSettings]>)[key] = value
    }
  }

  return {
    found: true,
    configPath,
    diff: actualDiff,
    unsupportedKeys
  }
}
