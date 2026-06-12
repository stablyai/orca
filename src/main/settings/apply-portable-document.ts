import { BrowserWindow } from 'electron'
import type { KeybindingService } from '../keybindings/keybinding-service'
import { rebuildAppMenu } from '../menu/register-app-menu'
import {
  getPortableSettingsFromExport,
  type SettingsExportDocument
} from '../../shared/settings-portability'
import type { SettingsUpdateApplier } from './apply-settings-updates'

export type PortableDocumentApplication = {
  portableSettingCount: number
  skippedSettingKeys: string[]
  includesKeybindings: boolean
}

/** Applies a validated settings-export document: portable settings go through
 *  the regular settings side-effect path, keybinding overrides replace the
 *  keybindings file, and every window plus the app menu is told about the new
 *  shortcuts. */
export async function applyPortableSettingsDocument(
  document: SettingsExportDocument,
  applySettings: SettingsUpdateApplier,
  currentSettings: Parameters<typeof getPortableSettingsFromExport>[1],
  keybindings?: KeybindingService
): Promise<PortableDocumentApplication> {
  const portable = getPortableSettingsFromExport(document, currentSettings)
  if (keybindings && document.keybindings !== undefined) {
    // Why: malformed shortcut payloads should fail before settings are
    // persisted, avoiding a "failed import" after partial settings writes.
    keybindings.validatePortableOverrides(document.keybindings)
  }
  await applySettings(portable.settings)
  if (keybindings && document.keybindings !== undefined) {
    const snapshot = keybindings.replacePortableOverrides(document.keybindings)
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) {
        window.webContents.send('keybindings:changed', snapshot)
      }
    }
    rebuildAppMenu()
  }
  return {
    portableSettingCount: Object.keys(portable.settings).length,
    skippedSettingKeys: portable.skippedSettingKeys,
    includesKeybindings: document.keybindings !== undefined
  }
}
