import { ipcMain } from 'electron';
export function registerCodexAccountHandlers(codexAccounts) {
    ipcMain.handle('codexAccounts:list', () => codexAccounts.listAccounts());
    ipcMain.handle('codexAccounts:add', () => codexAccounts.addAccount());
    ipcMain.handle('codexAccounts:reauthenticate', (_event, args) => codexAccounts.reauthenticateAccount(args.accountId));
    ipcMain.handle('codexAccounts:remove', (_event, args) => codexAccounts.removeAccount(args.accountId));
    ipcMain.handle('codexAccounts:select', (_event, args) => codexAccounts.selectAccount(args.accountId));
}
