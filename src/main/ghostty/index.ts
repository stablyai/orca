import { readFile, stat } from 'node:fs/promises'
import { platform } from 'node:os'
import type { GhosttyImportPreview, GlobalSettings } from '../../shared/global-settings-types'
import type { Store } from '../persistence'
import { findGhosttyConfigPaths } from './discovery'
import { parseGhosttyConfig } from './parser'
import { mapGhosttyToOrca } from './mapper'
import { resolveGhosttyThemeColors } from './theme-resolution'

// Bound config reads to avoid loading arbitrarily large files into main.
const MAX_CONFIG_BYTES = 1_000_000

// Compare nested values structurally with sorted keys while preserving meaningful array order.
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

function usesConditionalThemePair(themeName: string): boolean {
  return themeName
    .split(',')
    .map((part) => part.trim())
    .some((part) => part.startsWith('light:') || part.startsWith('dark:'))
}

// Theme colors are defaults; explicit config colors and palette entries take precedence.
async function applyThemeReference(parsed: Record<string, string | string[]>): Promise<string[]> {
  const rawTheme = parsed['theme']
  if (rawTheme === undefined) {
    return []
  }
  delete parsed['theme']

  const themeName = (Array.isArray(rawTheme) ? (rawTheme.at(-1) ?? '') : rawTheme).trim()
  if (usesConditionalThemePair(themeName)) {
    return ['theme (light:/dark: pairs not supported)']
  }

  const themeColors = await resolveGhosttyThemeColors(themeName)
  if (themeColors === null) {
    return ['theme (theme file not found)']
  }

  for (const [key, value] of Object.entries(themeColors)) {
    if (key === 'palette') {
      parsed[key] = [...asArray(value), ...asArray(parsed[key])]
    } else if (parsed[key] === undefined) {
      parsed[key] = value
    }
  }
  return []
}

export async function previewGhosttyImport(store: Store): Promise<GhosttyImportPreview> {
  const configPaths = await findGhosttyConfigPaths()
  if (configPaths.length === 0) {
    return { found: false, diff: {}, unsupportedKeys: [] }
  }

  const parsed: Record<string, string | string[]> = {}
  const readPaths: string[] = []
  let firstError: string | null = null
  for (const configPath of configPaths) {
    let content: string
    try {
      const info = await stat(configPath)
      if (info.size > MAX_CONFIG_BYTES) {
        if (firstError === null) {
          firstError = `Config file is too large to import (${info.size} bytes, limit ${MAX_CONFIG_BYTES}).`
        }
        continue
      }
      content = await readFile(configPath, 'utf-8')
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Could not read config file'
      if (firstError === null) {
        firstError = `Could not read config: ${message}`
      }
      continue
    }
    mergeParsedConfig(parsed, parseGhosttyConfig(content))
    readPaths.push(configPath)
  }

  if (readPaths.length === 0) {
    return {
      found: false,
      diff: {},
      unsupportedKeys: [],
      error: firstError ?? 'Could not read config'
    }
  }

  const themeUnsupportedKeys = await applyThemeReference(parsed)

  const { diff: rawDiff, unsupportedKeys: mappedUnsupportedKeys } = mapGhosttyToOrca(
    parsed,
    platform() === 'darwin'
  )
  const unsupportedKeys = [...mappedUnsupportedKeys, ...themeUnsupportedKeys]

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
    configPath: readPaths[0],
    configPaths: readPaths,
    diff: actualDiff,
    unsupportedKeys
  }
}
