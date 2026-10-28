import type {
  BrowserPasswordEntrySummary,
  BrowserPasswordFillOutcome,
  BrowserPasswordSavePromptResponse,
  BrowserPasswordsStatus
} from '../../shared/browser-passwords-types'
import type { GlobalSettings } from '../../shared/global-settings-types'
import { isTrustedBrowserRenderer } from './browser-renderer-trust'
import {
  applyBrowserPasswordSettingsToGuests,
  configureBrowserPasswords,
  fillBrowserPassword
} from '../browser-passwords/browser-password-guest-service'
import { respondToBrowserPasswordSavePrompt } from '../browser-passwords/browser-password-save-prompts'
import { browserPasswordReauthMethod } from '../browser-passwords/browser-password-reauth'
import { registerBrowserPasswordsEntryHandlers } from './browser-passwords-entry-ipc'
import { registerBrowserPasswordsImportHandlers } from './browser-passwords-import-ipc'
import {
  handleBrowserPasswordsChannel,
  readBrowserPasswordsArgs,
  readBrowserPasswordsVaultRequest
} from './browser-passwords-ipc-request'

export type BrowserPasswordsSettingsSource = {
  getSettings: () => Pick<
    GlobalSettings,
    | 'experimentalBrowserPasswords'
    | 'browserPasswordsOfferToSave'
    | 'browserPasswordsFillRequiresReauth'
  >
  onSettingsChanged?: (listener: (updates: Partial<GlobalSettings>) => void) => () => void
}

let stopWatchingSettings: (() => void) | null = null

export function registerBrowserPasswordsHandlers(store: BrowserPasswordsSettingsSource): void {
  configureBrowserPasswords(() => {
    const settings = store.getSettings()
    return {
      enabled: settings.experimentalBrowserPasswords === true,
      offerToSave: settings.browserPasswordsOfferToSave !== false,
      fillRequiresReauth: settings.browserPasswordsFillRequiresReauth === true
    }
  })
  stopWatchingSettings?.()
  stopWatchingSettings =
    store.onSettingsChanged?.((updates) => {
      if ('experimentalBrowserPasswords' in updates) {
        applyBrowserPasswordSettingsToGuests()
      }
    }) ?? null
  registerBrowserPasswordsEntryHandlers()
  registerBrowserPasswordsImportHandlers()

  handleBrowserPasswordsChannel(
    'browserPasswords:getStatus',
    (event, raw): BrowserPasswordsStatus | null => {
      const request = readBrowserPasswordsVaultRequest(event, raw)
      return request
        ? {
            enabled: store.getSettings().experimentalBrowserPasswords === true,
            availability: request.vault.availability(),
            reauthMethod: browserPasswordReauthMethod()
          }
        : null
    }
  )

  handleBrowserPasswordsChannel(
    'browserPasswords:list',
    (event, raw): BrowserPasswordEntrySummary[] | null => {
      const listed = readBrowserPasswordsVaultRequest(event, raw)?.vault.list()
      return listed?.ok ? listed.value : null
    }
  )

  handleBrowserPasswordsChannel('browserPasswords:respondSavePrompt', (event, raw): boolean => {
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
    return respondToBrowserPasswordSavePrompt(parsed)
  })

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
