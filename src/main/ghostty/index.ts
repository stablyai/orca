import { platform } from 'node:os'
import type { WebContents } from 'electron'
import type { GlobalSettings } from '../../shared/global-settings-types'
import type { TerminalConfigImportPreview } from '../../shared/terminal-config-import-preview'
import type { Store } from '../persistence/loading-store/store'
import { translateMain } from '../i18n/main-i18n'
import { readConfigFile } from '../terminal-config-import/config-file-reader'
import {
  previewTerminalConfigImport,
  type TerminalConfigImporter,
  type TerminalConfigMapping
} from '../terminal-config-import/preview'
import { findGhosttyConfigPaths } from './discovery'
import { parseGhosttyConfig } from './parser'
import { mapGhosttyToOrca } from './mapper'
import { importGhosttyTheme } from './theme-mapping'

type GhosttyConfig = Record<string, string | string[]>

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
  themeNames?: TerminalConfigImportPreview['terminalThemes']
  unsupportedKeys: string[]
}

// A slot whose theme the import selects gets exactly the config's explicit colors; other slots keep merging them.
async function themeReferencePatch(
  rawTheme: string | string[] | undefined,
  explicit: Partial<GlobalSettings>,
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
  const colors = explicit.terminalColorOverrides ?? {}
  // Explicit config keys (e.g. split-divider-color) override what the theme supplies, as in Ghostty.
  const themeDefaults = Object.fromEntries(
    Object.entries(diff).filter(([key]) => !Object.hasOwn(explicit, key))
  )
  return {
    diff: {
      ...themeDefaults,
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

const GHOSTTY_IMPORTER: TerminalConfigImporter<GhosttyConfig> = {
  appName: 'Ghostty',
  pickerTitle: () => translateMain('native.dialog.importGhosttyConfig', 'Import Ghostty Config'),
  discover: findGhosttyConfigPaths,
  load: async (configPaths) => {
    const config: GhosttyConfig = {}
    const readPaths: string[] = []
    let firstError: string | null = null
    for (const configPath of configPaths) {
      const read = await readConfigFile(configPath)
      if (!read.ok) {
        firstError ??= read.error
        continue
      }
      mergeParsedConfig(config, parseGhosttyConfig(read.content))
      readPaths.push(configPath)
    }
    return { config, readPaths, firstError }
  },
  map: async (config, { currentSettings, pickedConfigDir }): Promise<TerminalConfigMapping> => {
    const { theme: rawTheme, ...configKeys } = config
    const mapped = mapGhosttyToOrca(configKeys, platform() === 'darwin')
    const theme = await themeReferencePatch(
      rawTheme,
      mapped.diff,
      pickedConfigDir,
      currentSettings
    )
    return {
      diff: { ...mapped.diff, ...theme.diff },
      unsupportedKeys: [...mapped.unsupportedKeys, ...theme.unsupportedKeys],
      ...(theme.themeNames ? { terminalThemes: theme.themeNames } : {})
    }
  }
}

export function previewGhosttyImport(
  store: Store,
  source?: unknown,
  webContents?: WebContents
): Promise<TerminalConfigImportPreview> {
  return previewTerminalConfigImport(GHOSTTY_IMPORTER, store, source, webContents)
}
