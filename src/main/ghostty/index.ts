import { readFile, stat } from 'node:fs/promises'
import { platform } from 'node:os'
import path from 'node:path'
import type { WebContents } from 'electron'
import type {
  GhosttyImportPreview,
  GhosttyImportSource,
  GlobalSettings
} from '../../shared/global-settings-types'
import type { TerminalColorOverrides } from '../../shared/terminal-color-overrides'
import type { Store } from '../persistence/loading-store/store'
import { translateMain } from '../i18n/main-i18n'
import { validateImportSource } from '../import-source-validation'
import { chooseTerminalConfigFile } from '../terminal-config-import/choose-config-file'
import { findGhosttyConfigPaths } from './discovery'
import { parseGhosttyConfig } from './parser'
import { mapGhosttyToOrca } from './mapper'
import { importGhosttyTheme } from './theme-mapping'

// Bound config reads to avoid loading arbitrarily large files into main.
const MAX_CONFIG_BYTES = 1_000_000
const GHOSTTY_IMPORT_SOURCE_KINDS = ['auto', 'chooseFile'] as const

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

// An unset object setting already matches an import that clears it.
function emptyLike(value: unknown): unknown {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? {} : undefined
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
    // Ghostty appends repeatable keys across config files instead of replacing them.
    if (key === 'palette' || key === 'font-family') {
      target[key] = [...asArray(target[key]), ...asArray(value)]
      continue
    }
    target[key] = value
  }
}

type ThemeReferencePatch = {
  diff: Partial<GlobalSettings>
  themeNames?: GhosttyImportPreview['terminalThemes']
  unsupportedKeys: string[]
}

// A slot whose theme the import selects gets exactly the config's explicit colors; other slots keep merging them.
async function themeReferencePatch(
  rawTheme: string | string[] | undefined,
  explicitColors: TerminalColorOverrides | undefined,
  pickedConfigDir: string | undefined,
  currentSettings: GlobalSettings
): Promise<ThemeReferencePatch> {
  if (rawTheme === undefined) {
    return { diff: {}, unsupportedKeys: [] }
  }
  const { diff, themeNames, unsupportedKeys } = await importGhosttyTheme(
    Array.isArray(rawTheme) ? (rawTheme.at(-1) ?? '') : rawTheme,
    pickedConfigDir,
    currentSettings.terminalCustomThemes
  )
  if (themeNames.dark === undefined && themeNames.light === undefined) {
    return { diff: {}, unsupportedKeys }
  }
  const colors = explicitColors ?? {}
  return {
    diff: {
      ...diff,
      terminalColorOverrides:
        themeNames.dark !== undefined
          ? colors
          : { ...currentSettings.terminalColorOverrides, ...colors },
      ...(themeNames.light !== undefined ? { terminalColorOverridesLight: colors } : {})
    },
    themeNames,
    unsupportedKeys
  }
}

async function resolveConfigPaths(
  source: GhosttyImportSource,
  webContents?: WebContents
): Promise<string[] | null> {
  switch (source.kind) {
    case 'auto':
      return findGhosttyConfigPaths()
    case 'chooseFile': {
      const picked = await chooseTerminalConfigFile(
        translateMain('native.dialog.importGhosttyConfig', 'Import Ghostty Config'),
        webContents
      )
      return picked === null ? null : [picked]
    }
  }
}

export async function previewGhosttyImport(
  store: Store,
  source: unknown = { kind: 'auto' },
  webContents?: WebContents
): Promise<GhosttyImportPreview> {
  const validatedSource = validateImportSource(source, GHOSTTY_IMPORT_SOURCE_KINDS)
  if (!validatedSource) {
    return { found: false, diff: {}, unsupportedKeys: [], error: 'Invalid Ghostty import source.' }
  }
  const configPaths = await resolveConfigPaths(validatedSource, webContents)
  if (configPaths === null) {
    return { found: false, canceled: true, diff: {}, unsupportedKeys: [] }
  }
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
      // Picked paths can be devices or FIFOs whose zero size would slip past the byte limit.
      if (!info.isFile()) {
        firstError ??= 'Config path is not a regular file.'
        continue
      }
      if (info.size > MAX_CONFIG_BYTES) {
        firstError ??= `Config file is too large to import (${info.size} bytes, limit ${MAX_CONFIG_BYTES}).`
        continue
      }
      content = await readFile(configPath, 'utf-8')
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Could not read config file'
      firstError ??= `Could not read config: ${message}`
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

  const { theme: rawTheme, ...configKeys } = parsed
  const { diff: rawDiff, unsupportedKeys: mappedUnsupportedKeys } = mapGhosttyToOrca(
    configKeys,
    platform() === 'darwin'
  )
  const currentSettings = store.getSettings()
  const theme = await themeReferencePatch(
    rawTheme,
    rawDiff.terminalColorOverrides,
    validatedSource.kind === 'chooseFile' ? path.dirname(readPaths[0]) : undefined,
    currentSettings
  )
  Object.assign(rawDiff, theme.diff)
  const unsupportedKeys = [...mappedUnsupportedKeys, ...theme.unsupportedKeys]

  const actualDiff: Partial<typeof rawDiff> = {}
  for (const key of Object.keys(rawDiff) as (keyof typeof rawDiff)[]) {
    const value = rawDiff[key]
    if (value !== undefined && !valuesEqual(currentSettings[key] ?? emptyLike(value), value)) {
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
    unsupportedKeys,
    ...(theme.themeNames ? { terminalThemes: theme.themeNames } : {})
  }
}
