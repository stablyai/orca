import { ipcMain } from 'electron'
import type { CodexAccountAddTarget, CodexAccountService } from '../codex-accounts/service'
import type { CodexAccountSelectionTarget } from '../codex-accounts/runtime-selection'
import { isTrustedUIRenderer } from './ui'

function assertTrustedCodexAccountSender(event: Electron.IpcMainInvokeEvent): void {
  if (!isTrustedUIRenderer(event.sender)) {
    throw new Error('Unauthorized Codex account sender')
  }
}

export function registerCodexAccountHandlers(codexAccounts: CodexAccountService): void {
  ipcMain.handle('codexAccounts:list', (event) => {
    assertTrustedCodexAccountSender(event)
    return codexAccounts.listAccounts()
  })
  ipcMain.handle('codexAccounts:add', (event, args?: CodexAccountAddTarget) => {
    assertTrustedCodexAccountSender(event)
    return codexAccounts.addAccount(args)
  })
  ipcMain.handle('codexAccounts:reauthenticate', (event, args: { accountId: string }) => {
    assertTrustedCodexAccountSender(event)
    return codexAccounts.reauthenticateAccount(args.accountId)
  })
  ipcMain.handle('codexAccounts:cancelReauthentication', (event, args: { accountId: string }) => {
    assertTrustedCodexAccountSender(event)
    return codexAccounts.cancelReauthentication(args.accountId)
  })
  ipcMain.handle('codexAccounts:remove', (event, args: { accountId: string }) => {
    assertTrustedCodexAccountSender(event)
    return codexAccounts.removeAccount(args.accountId)
  })
  ipcMain.handle(
    'codexAccounts:select',
    (event, args: { accountId: string | null } & CodexAccountSelectionTarget) => {
      assertTrustedCodexAccountSender(event)
      if (!args.runtime) {
        // Why: older renderer surfaces selected by account id only. Let the
        // service infer the account's runtime instead of treating missing
        // runtime as Windows/host and rejecting valid WSL accounts.
        return codexAccounts.selectAccount(args.accountId)
      }
      return codexAccounts.selectAccountForTarget(args.accountId, args)
    }
  )
}
