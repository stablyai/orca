import { readFile } from 'fs/promises'
import { platform } from 'os'
import type { GlobalSettings, GhosttyImportPreview } from '../../shared/types'
import type { Store } from '../persistence'
import { findGhosttyConfigPath } from './discovery'
import { parseGhosttyConfig } from './parser'
import { mapGhosttyToOrca } from './mapper'

// Why: mapGhosttyToOrca creates new object instances for nested values like
// terminalColorOverrides. A reference comparison (!==) would always report
// them as changed even when the contents are identical.
function valuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true
  }
  if (typeof a === 'object' && a !== null && typeof b === 'object' && b !== null) {
    const stableStringify = (v: unknown): string =>
      typeof v === 'object' && v !== null && !Array.isArray(v)
        ? JSON.stringify(
            Object.fromEntries(
              Object.entries(v as object).sort(([ka], [kb]) =>
                (ka as string).localeCompare(kb as string)
              )
            )
          )
        : JSON.stringify(v)
    return stableStringify(a) === stableStringify(b)
  }
  return false
}

export async function previewGhosttyImport(store: Store): Promise<GhosttyImportPreview> {
  const configPath = await findGhosttyConfigPath()
  if (!configPath) {
    return { found: false, diff: {}, unsupportedKeys: [] }
  }

  let content: string
  try {
    content = await readFile(configPath, 'utf-8')
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Could not read config file'
    return {
      found: false,
      diff: {},
      unsupportedKeys: [],
      error: `Could not read config: ${message}`
    }
  }

  const parsed = parseGhosttyConfig(content)
  const { diff: rawDiff, unsupportedKeys } = mapGhosttyToOrca(parsed, platform() === 'darwin')

  const currentSettings = store.getSettings()
  const actualDiff: Partial<typeof rawDiff> = {}
  for (const key of Object.keys(rawDiff) as (keyof typeof rawDiff)[]) {
    const value = rawDiff[key]
    if (value !== undefined && !valuesEqual(currentSettings[key], value)) {
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
