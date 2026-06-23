import { readFile, stat } from 'fs/promises'
import { platform } from 'os'
import type { GlobalSettings, GhosttyImportPreview } from '../../shared/types'
import type { Store } from '../persistence'
import { findGhosttyConfigPaths } from './discovery'
import { parseGhosttyConfig } from './parser'
import { mapGhosttyToOrca } from './mapper'

// Why: defensive upper bound on the Ghostty config size we're willing to read
// into memory on the main process. Real configs are a few KB; anything past
// this is almost certainly a symlink mistake or a pathological file and we
// would rather surface an error than OOM the main process.
const MAX_CONFIG_BYTES = 1_000_000

// Why: mapGhosttyToOrca creates new object instances for nested values like
// terminalColorOverrides. A reference comparison (!==) would always report
// them as changed even when the contents are identical. The stringifier sorts
// keys at every object depth so persisted settings whose storage preserves a
// different key order compare equal. Arrays keep their ordering (meaningful
// for list-valued settings).
function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') {
    return JSON.stringify(v)
  }
  if (Array.isArray(v)) {
    return `[${v.map(stableStringify).join(',')}]`
  }
  const entries = Object.entries(v as Record<string, unknown>).sort(([ka], [kb]) =>
    ka.localeCompare(kb)
  )
  return `{${entries.map(([k, val]) => `${JSON.stringify(k)}:${stableStringify(val)}`).join(',')}}`
}

function valuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true
  }
  if (typeof a === 'object' && a !== null && typeof b === 'object' && b !== null) {
    return stableStringify(a) === stableStringify(b)
  }
  return false
}

function asArray(value: string | string[] | undefined): string[] {
  if (value === undefined) {
    return []
  }
  return Array.isArray(value) ? value : [value]
}

function mergeParsedConfig(
  target: Record<string, string | string[]>,
  parsed: Record<string, string | string[]>
): void {
  for (const [key, value] of Object.entries(parsed)) {
    if (key === 'palette') {
      target[key] = [...asArray(target[key]), ...asArray(value)]
      continue
    }
    target[key] = value
  }
}

export async function previewGhosttyImport(store: Store): Promise<GhosttyImportPreview> {
  const configPaths = await findGhosttyConfigPaths()
  if (configPaths.length === 0) {
    return { found: false, diff: {}, unsupportedKeys: [] }
  }

  const parsed: Record<string, string | string[]> = {}
  for (const configPath of configPaths) {
    let content: string
    try {
      const info = await stat(configPath)
      if (info.size > MAX_CONFIG_BYTES) {
        return {
          found: false,
          diff: {},
          unsupportedKeys: [],
          error: `Config file is too large to import (${info.size} bytes, limit ${MAX_CONFIG_BYTES}).`
        }
      }
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
    mergeParsedConfig(parsed, parseGhosttyConfig(content))
  }

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
    configPath: configPaths[0],
    configPaths,
    diff: actualDiff,
    unsupportedKeys
  }
}
