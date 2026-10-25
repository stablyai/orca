import { ipcMain } from 'electron'
import type { CodexAccountAddTarget, CodexAccountService } from '../codex-accounts/service'
import type { CodexAccountSelectionTarget } from '../codex-accounts/runtime-selection'
import { broadcastCodexPendingLoginUrl } from './codex-pending-login-url-broadcast'
import { openAccountSignInLink } from './account-sign-in-link-opener'
import { listRecordedCodexPaneLanes } from '../codex/codex-pane-account-registry'
import { forgetStaleCodexPanes, listStaleCodexPanes } from '../codex/codex-stale-pane-accounts'
import type { GlobalSettings } from '../../shared/global-settings-types'

export function registerCodexAccountHandlers(
  codexAccounts: CodexAccountService,
  getSettings?: () => GlobalSettings
): void {
  ipcMain.handle('codexAccounts:listStalePanes', (_event, args: { ptyIds?: unknown }) => {
    const settings = getSettings?.()
    if (!settings || !Array.isArray(args?.ptyIds)) {
      return []
    }
    return listStaleCodexPanes({
      ptyIds: args.ptyIds.filter((ptyId): ptyId is string => typeof ptyId === 'string'),
      settings
    })
  })
  ipcMain.handle('codexAccounts:listRecordedPaneLanes', (_event, args: { ptyIds?: unknown }) => {
    if (!Array.isArray(args?.ptyIds)) {
      return {}
    }
    return listRecordedCodexPaneLanes(
      args.ptyIds.filter((ptyId): ptyId is string => typeof ptyId === 'string')
    )
  })
  ipcMain.handle('codexAccounts:forgetStalePanes', (_event, args: { ptyIds?: unknown }) => {
    if (!Array.isArray(args?.ptyIds)) {
      return
    }
    forgetStaleCodexPanes(args.ptyIds.filter((ptyId): ptyId is string => typeof ptyId === 'string'))
  })
  ipcMain.handle('codexAccounts:list', () => codexAccounts.listAccounts())
  ipcMain.handle('codexAccounts:add', (_event, args?: CodexAccountAddTarget) =>
    codexAccounts.addAccount(args)
  )
  ipcMain.handle('codexAccounts:cancelPendingLogin', () => codexAccounts.cancelPendingLogin())
  ipcMain.handle('codexAccounts:pendingLoginUrl', () => codexAccounts.getPendingLoginUrl())
  // Settings reads the current link on mount; broadcasts carry later changes.
  codexAccounts.onPendingLoginUrlChanged(broadcastCodexPendingLoginUrl)
  codexAccounts.setWslLoginUrlOpener((url) => openAccountSignInLink('codex', url))
  ipcMain.handle(
    'codexAccounts:reauthenticate',
    (_event, args: { accountId: string; activateIfSelectionWasEmpty?: boolean }) =>
      codexAccounts.reauthenticateAccount(args.accountId, {
        activateIfSelectionWasEmpty: args.activateIfSelectionWasEmpty === true
      })
  )
  ipcMain.handle('codexAccounts:remove', (_event, args: { accountId: string }) =>
    codexAccounts.removeAccount(args.accountId)
  )
  ipcMain.handle(
    'codexAccounts:select',
    (_event, args: { accountId: string | null } & CodexAccountSelectionTarget) => {
      if (!args.runtime) {
        // Legacy renderers omit runtime; infer it from the account so valid WSL selection still works.
        return codexAccounts.selectAccount(args.accountId)
      }
      return codexAccounts.selectAccountForTarget(args.accountId, args)
    }
  )
}
