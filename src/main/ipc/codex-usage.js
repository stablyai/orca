import { ipcMain } from 'electron';
export function registerCodexUsageHandlers(codexUsage) {
    ipcMain.handle('codexUsage:getScanState', () => codexUsage.getScanState());
    ipcMain.handle('codexUsage:setEnabled', (_event, args) => codexUsage.setEnabled(args.enabled));
    ipcMain.handle('codexUsage:refresh', (_event, args) => codexUsage.refresh(args?.force ?? false));
    ipcMain.handle('codexUsage:getSummary', (_event, args) => codexUsage.getSummary(args.scope, args.range));
    ipcMain.handle('codexUsage:getDaily', (_event, args) => codexUsage.getDaily(args.scope, args.range));
    ipcMain.handle('codexUsage:getBreakdown', (_event, args) => codexUsage.getBreakdown(args.scope, args.range, args.kind));
    ipcMain.handle('codexUsage:getRecentSessions', (_event, args) => codexUsage.getRecentSessions(args.scope, args.range, args.limit));
}
