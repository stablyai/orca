import { ipcMain } from 'electron'
import type {
  BrowserPasswordEntrySummary,
  BrowserPasswordFillOutcome,
  BrowserPasswordSavePromptResponse,
  BrowserPasswordsStatus
} from '../../../shared/browser/passwords/browser-passwords-types'
import type { GlobalSettings } from '../../../shared/settings/global-settings-types'
import { isTrustedBrowserRenderer } from './browser-renderer-trust'
import {
  configureBrowserPasswords,
  fillBrowserPassword
} from '../../browser-passwords/browser-password-guest-service'
import { registerLazyIpcHandleGroup } from '../lazy-ipc-handle-group'
import {
  handleBrowserPasswordsChannel,
  readBrowserPasswordsArgs,
  readBrowserPasswordsVaultRequest
} from './browser-passwords-ipc-request'

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
  configureBrowserPasswords(() => {
    const settings = store.getSettings()
    return {
      offerToSave: settings.browserPasswordsOfferToSave !== false,
      fillRequiresReauth: settings.browserPasswordsFillRequiresReauth === true
    }
  })
  for (const channel of [
    ...BROWSER_PASSWORDS_ENTRY_CHANNELS,
    ...BROWSER_PASSWORDS_IMPORT_CHANNELS
  ]) {
    ipcMain.removeHandler(channel)
  }
  registerLazyIpcHandleGroup(BROWSER_PASSWORDS_ENTRY_CHANNELS, async (ipc) => {
    const { registerBrowserPasswordsEntryHandlers } = await import('./browser-passwords-entry-ipc')
    registerBrowserPasswordsEntryHandlers(ipc)
  })
  registerLazyIpcHandleGroup(BROWSER_PASSWORDS_IMPORT_CHANNELS, async (ipc) => {
    const { registerBrowserPasswordsImportHandlers } =
      await import('./browser-passwords-import-ipc')
    registerBrowserPasswordsImportHandlers(ipc)
  })

  handleBrowserPasswordsChannel(
    'browserPasswords:getStatus',
    async (event, raw): Promise<BrowserPasswordsStatus | null> => {
      const request = readBrowserPasswordsVaultRequest(event, raw)
      if (!request) {
        return null
      }
      const { browserPasswordReauthMethod } =
        await import('../../browser-passwords/browser-password-reauth')
      return {
        availability: request.vault.availability(),
        reauthMethod: await browserPasswordReauthMethod()
      }
    }
  )

  handleBrowserPasswordsChannel(
    'browserPasswords:list',
    (event, raw): BrowserPasswordEntrySummary[] | null => {
      const listed = readBrowserPasswordsVaultRequest(event, raw)?.vault.list()
      return listed?.ok ? listed.value : null
    }
  )

  handleBrowserPasswordsChannel(
    'browserPasswords:respondSavePrompt',
    async (event, raw): Promise<boolean> => {
      const response = readBrowserPasswordsArgs(raw)
      const { promptId, action, username } = response
      if (
        !isTrustedBrowserRenderer(event.sender) ||
        typeof promptId !== 'string' ||
        (action !== 'save' && action !== 'never' && action !== 'dismiss')
      ) {
        return false
      }
      const parsed: BrowserPasswordSavePromptResponse = {
        promptId,
        action,
        ...(typeof username === 'string' ? { username } : {})
      }
      const { respondToBrowserPasswordSavePrompt } =
        await import('../../browser-passwords/browser-password-save-prompts')
      return respondToBrowserPasswordSavePrompt(parsed)
    }
  )

  handleBrowserPasswordsChannel(
    'browserPasswords:fill',
    (event, raw): Promise<BrowserPasswordFillOutcome> => {
      const { browserPageId, fieldToken, entryId } = readBrowserPasswordsArgs(raw)
      if (
        !isTrustedBrowserRenderer(event.sender) ||
        typeof browserPageId !== 'string' ||
        typeof fieldToken !== 'string' ||
        typeof entryId !== 'string'
      ) {
        return Promise.resolve({ ok: false, reason: 'unavailable' })
      }
      return fillBrowserPassword({ browserPageId, fieldToken, entryId })
    }
  )
}
