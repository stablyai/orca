import { ipcMain } from 'electron'
import type { BrowserWebAuthnAccountResponse } from '../../../shared/browser/prompts/browser-webauthn-account'
import type {
  BrowserPagePromptResponse,
  BrowserPagePromptResult
} from '../../../shared/browser/prompts/browser-page-prompt'
import { respondToBrowserWebAuthnAccountRequest } from '../../browser/webauthn/browser-webauthn-account-picker'
import { isTrustedBrowserRenderer } from './browser-renderer-trust'

export function registerBrowserPromptHandlers(): void {
  ipcMain.removeHandler('browser:respondWebAuthnAccount')
  ipcMain.removeHandler('browser:respondPagePrompt')
  ipcMain.removeHandler('browser:openStreamedExternalAppLink')

  ipcMain.handle(
    'browser:respondWebAuthnAccount',
    (event, response: BrowserWebAuthnAccountResponse): boolean => {
      if (!isTrustedBrowserRenderer(event.sender)) {
        return false
      }
      return respondToBrowserWebAuthnAccountRequest(event.sender, response)
    }
  )

  ipcMain.handle(
    'browser:respondPagePrompt',
    async (event, response: BrowserPagePromptResponse): Promise<BrowserPagePromptResult> => {
      if (!isTrustedBrowserRenderer(event.sender)) {
        return 'rejected'
      }
      const { respondToBrowserPagePrompt } =
        await import('../../browser/guest-lifecycle/prompts/browser-page-prompts')
      return respondToBrowserPagePrompt(event.sender, response)
    }
  )

  ipcMain.handle(
    'browser:openStreamedExternalAppLink',
    async (event, rawUrl: unknown): Promise<boolean> => {
      if (!isTrustedBrowserRenderer(event.sender)) {
        return false
      }
      const { openStreamedBrowserExternalAppLink } =
        await import('../../browser/guest-lifecycle/prompts/browser-external-app-launch')
      return openStreamedBrowserExternalAppLink(rawUrl)
    }
  )
}
