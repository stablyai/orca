import { homedir, platform } from 'node:os'
import type { WebContents } from 'electron'
import type { TerminalConfigImportPreview } from '../../shared/terminal-config-import-preview'
import type { Store } from '../persistence/loading-store/store'
import { translateMain } from '../i18n/main-i18n'
import {
  previewTerminalConfigImport,
  type TerminalConfigImporter
} from '../terminal-config-import/preview'
import { findKittyConfigPaths } from './discovery'
import { mapKittyToOrca } from './mapper'
import { loadKittyConfig, type KittyConfig } from './parser'

const KITTY_IMPORTER: TerminalConfigImporter<KittyConfig> = {
  appName: 'Kitty',
  pickerTitle: () => translateMain('native.dialog.importKittyConfig', 'Import Kitty Config'),
  discover: findKittyConfigPaths,
  // Kitty reads one kitty.conf; anything else arrives through its include directives.
  load: ([entryPath = '']) => loadKittyConfig(entryPath, homedir()),
  map: async (config) => mapKittyToOrca(config, platform() === 'darwin')
}

export function previewKittyImport(
  store: Store,
  source?: unknown,
  webContents?: WebContents
): Promise<TerminalConfigImportPreview> {
  return previewTerminalConfigImport(KITTY_IMPORTER, store, source, webContents)
}
