import path from 'node:path'
import type { WebContents } from 'electron'
import type { GlobalSettings } from '../../shared/global-settings-types'
import type { TerminalConfigImportPreview } from '../../shared/terminal-config-import-preview'
import type { Store } from '../persistence/loading-store/store'
import { validateImportSource } from '../import-source-validation'
import { chooseTerminalConfigFile } from './choose-config-file'
import { settingsChanges } from './settings-changes'

const IMPORT_SOURCE_KINDS = ['auto', 'chooseFile'] as const

export type LoadedTerminalConfig<Config> = {
  config: Config
  /** Files that were read, in load order; empty when none could be read. */
  readPaths: string[]
  firstError: string | null
}

export type TerminalConfigMapping = Pick<
  TerminalConfigImportPreview,
  'diff' | 'unsupportedKeys' | 'terminalThemes'
>

export type TerminalConfigMappingContext = {
  currentSettings: GlobalSettings
  /** Directory of a file the user picked, for resolving theme files beside it. */
  pickedConfigDir?: string
}

/** One terminal app's half of the shared discover → parse → map → preview pipeline. */
export type TerminalConfigImporter<Config> = {
  appName: string
  pickerTitle: () => string
  discover: () => Promise<string[]>
  load: (configPaths: string[]) => Promise<LoadedTerminalConfig<Config>>
  map: (config: Config, context: TerminalConfigMappingContext) => Promise<TerminalConfigMapping>
}

export async function previewTerminalConfigImport<Config>(
  importer: TerminalConfigImporter<Config>,
  store: Store,
  source: unknown = { kind: 'auto' },
  webContents?: WebContents
): Promise<TerminalConfigImportPreview> {
  const validatedSource = validateImportSource(source, IMPORT_SOURCE_KINDS)
  if (!validatedSource) {
    return {
      found: false,
      diff: {},
      unsupportedKeys: [],
      error: `Invalid ${importer.appName} import source.`
    }
  }

  let pickedConfigDir: string | undefined
  let configPaths: string[]
  if (validatedSource.kind === 'chooseFile') {
    const picked = await chooseTerminalConfigFile(importer.pickerTitle(), webContents)
    if (picked === null) {
      return { found: false, canceled: true, diff: {}, unsupportedKeys: [] }
    }
    pickedConfigDir = path.dirname(picked)
    configPaths = [picked]
  } else {
    configPaths = await importer.discover()
  }
  if (configPaths.length === 0) {
    return { found: false, diff: {}, unsupportedKeys: [] }
  }

  const { config, readPaths, firstError } = await importer.load(configPaths)
  if (readPaths.length === 0) {
    return {
      found: false,
      diff: {},
      unsupportedKeys: [],
      error: firstError ?? 'Could not read config'
    }
  }

  const currentSettings = store.getSettings()
  const { diff, unsupportedKeys, terminalThemes } = await importer.map(config, {
    currentSettings,
    pickedConfigDir
  })
  return {
    found: true,
    configPath: readPaths[0],
    configPaths: readPaths,
    diff: settingsChanges(currentSettings, diff),
    unsupportedKeys,
    ...(terminalThemes ? { terminalThemes } : {})
  }
}
