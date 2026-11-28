import { ipcMain } from 'electron'
import type { GlobalSettings } from '../../../shared/settings/global-settings-types'
import { setBrowserPasswordSettingsSource } from '../../browser-passwords/browser-password-settings-source'
import { registerLazyIpcHandleGroup } from '../lazy-ipc-handle-group'

const BROWSER_PASSWORDS_CORE_CHANNELS = [
  'browserPasswords:getStatus',
  'browserPasswords:list',
  'browserPasswords:respondSavePrompt',
  'browserPasswords:fill'
] as const

const BROWSER_PASSWORDS_ENTRY_CHANNELS = [
  'browserPasswords:getEntryDetails',
  'browserPasswords:copyPassword',
  'browserPasswords:addEntry',
  'browserPasswords:updateEntry',
  'browserPasswords:deleteEntry',
  'browserPasswords:deleteAll',
  'browserPasswords:listNever',
  'browserPasswords:removeNever'
] as const

const BROWSER_PASSWORDS_IMPORT_CHANNELS = [
  'browserPasswords:importCsv',
  'browserPasswords:importFromBrowser'
] as const

export type BrowserPasswordsSettingsSource = {
  getSettings: () => Pick<
    GlobalSettings,
    'browserPasswordsOfferToSave' | 'browserPasswordsFillRequiresReauth'
  >
}

export function registerBrowserPasswordsHandlers(store: BrowserPasswordsSettingsSource): void {
  setBrowserPasswordSettingsSource(() => {
    const settings = store.getSettings()
    return {
      offerToSave: settings.browserPasswordsOfferToSave !== false,
      fillRequiresReauth: settings.browserPasswordsFillRequiresReauth === true
    }
  })
  for (const channel of [
    ...BROWSER_PASSWORDS_CORE_CHANNELS,
    ...BROWSER_PASSWORDS_ENTRY_CHANNELS,
    ...BROWSER_PASSWORDS_IMPORT_CHANNELS
  ]) {
    ipcMain.removeHandler(channel)
  }
  registerLazyIpcHandleGroup(BROWSER_PASSWORDS_CORE_CHANNELS, async (ipc) => {
    const { registerBrowserPasswordsCoreHandlers } = await import('./browser-passwords-core-ipc')
    registerBrowserPasswordsCoreHandlers(ipc)
  })
  registerLazyIpcHandleGroup(BROWSER_PASSWORDS_ENTRY_CHANNELS, async (ipc) => {
    const { registerBrowserPasswordsEntryHandlers } = await import('./browser-passwords-entry-ipc')
    registerBrowserPasswordsEntryHandlers(ipc)
  })
  registerLazyIpcHandleGroup(BROWSER_PASSWORDS_IMPORT_CHANNELS, async (ipc) => {
    const { registerBrowserPasswordsImportHandlers } =
      await import('./browser-passwords-import-ipc')
    registerBrowserPasswordsImportHandlers(ipc)
  })
}
