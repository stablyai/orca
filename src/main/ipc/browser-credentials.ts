import { ipcMain } from 'electron'
import type { BrowserCredentialVault } from '../browser/credential-vault'
import type {
  SaveBrowserCredentialArgs,
  UpdateBrowserCredentialArgs
} from '../../shared/browser-credential-types'

type BrowserManagerLike = {
  injectPasswordBridge: (browserTabId: string, token: string, enabled: boolean) => Promise<boolean>
  fillPasswordField: (
    browserTabId: string,
    fieldId: string,
    username: string,
    password: string
  ) => Promise<boolean>
}

export type RegisterBrowserCredentialHandlersDeps = {
  vault: BrowserCredentialVault
  browserManager: BrowserManagerLike
  isTrusted: (sender: Electron.WebContents) => boolean
}

export function registerBrowserCredentialHandlers({
  vault,
  browserManager,
  isTrusted
}: RegisterBrowserCredentialHandlersDeps): void {
  const channels = [
    'browser:credentials:status',
    'browser:credentials:matchesForOrigin',
    'browser:credentials:list',
    'browser:credentials:reveal',
    'browser:credentials:save',
    'browser:credentials:add',
    'browser:credentials:update',
    'browser:credentials:delete',
    'browser:credentials:injectBridge',
    'browser:credentials:fill'
  ]
  channels.forEach((c) => ipcMain.removeHandler(c))

  ipcMain.handle('browser:credentials:status', (e) =>
    isTrusted(e.sender) ? vault.status() : { available: false, reason: 'untrusted' }
  )
  ipcMain.handle('browser:credentials:matchesForOrigin', (e, args: { origin: string }) =>
    isTrusted(e.sender) ? vault.matchesForOrigin(args.origin) : []
  )
  ipcMain.handle('browser:credentials:list', (e) => (isTrusted(e.sender) ? vault.listAll() : []))
  ipcMain.handle('browser:credentials:reveal', (e, args: { id: string }) =>
    isTrusted(e.sender) ? vault.reveal(args.id) : null
  )
  ipcMain.handle('browser:credentials:save', (e, args: SaveBrowserCredentialArgs) =>
    isTrusted(e.sender) ? vault.save(args) : { outcome: 'unchanged', entry: null }
  )
  ipcMain.handle('browser:credentials:add', (e, args: SaveBrowserCredentialArgs) =>
    isTrusted(e.sender) ? vault.add(args) : null
  )
  ipcMain.handle('browser:credentials:update', (e, args: UpdateBrowserCredentialArgs) =>
    isTrusted(e.sender) ? vault.update(args) : null
  )
  ipcMain.handle('browser:credentials:delete', (e, args: { id: string }) =>
    isTrusted(e.sender) ? vault.delete(args.id) : false
  )
  ipcMain.handle(
    'browser:credentials:injectBridge',
    (e, args: { browserTabId: string; token: string; enabled: boolean }) =>
      isTrusted(e.sender)
        ? browserManager.injectPasswordBridge(args.browserTabId, args.token, args.enabled)
        : false
  )

  // Security keystone: decrypt + read username in main; inject straight into the
  // guest. The plaintext password is never returned to the renderer.
  ipcMain.handle(
    'browser:credentials:fill',
    async (e, args: { browserTabId: string; entryId: string; fieldId: string }) => {
      if (!isTrusted(e.sender)) {
        return false
      }
      const password = vault.reveal(args.entryId)
      if (password == null) {
        return false
      }
      const entry = vault.listAll().find((c) => c.id === args.entryId)
      if (!entry) {
        return false
      }
      const ok = await browserManager.fillPasswordField(
        args.browserTabId,
        args.fieldId,
        entry.username,
        password
      )
      if (ok) {
        vault.markUsed(args.entryId)
      }
      return ok
    }
  )
}
