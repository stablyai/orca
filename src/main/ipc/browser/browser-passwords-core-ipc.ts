import { ipcMain } from 'electron'
import type {
  BrowserPasswordEntrySummary,
  BrowserPasswordFillOutcome,
  BrowserPasswordSavePromptResponse,
  BrowserPasswordsStatus
} from '../../../shared/browser/passwords/browser-passwords-types'
import { isTrustedBrowserRenderer } from './browser-renderer-trust'
import { fillBrowserPassword } from '../../browser-passwords/browser-password-guest-service'
import type { IpcHandleRegistrar } from '../lazy-ipc-handle-group'
import {
  handleBrowserPasswordsChannel,
  readBrowserPasswordsArgs,
  readBrowserPasswordsVaultRequest
} from './browser-passwords-ipc-request'

export function registerBrowserPasswordsCoreHandlers(ipc: IpcHandleRegistrar = ipcMain): void {
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
    },
    ipc
  )

  handleBrowserPasswordsChannel(
    'browserPasswords:list',
    (event, raw): BrowserPasswordEntrySummary[] | null => {
      const listed = readBrowserPasswordsVaultRequest(event, raw)?.vault.list()
      return listed?.ok ? listed.value : null
    },
    ipc
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
    },
    ipc
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
    },
    ipc
  )
}
