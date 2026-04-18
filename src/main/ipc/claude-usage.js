import { ipcMain } from 'electron';
export function registerClaudeUsageHandlers(claudeUsage) {
    ipcMain.handle('claudeUsage:getScanState', () => claudeUsage.getScanState());
    ipcMain.handle('claudeUsage:setEnabled', (_event, args) => claudeUsage.setEnabled(args.enabled));
    ipcMain.handle('claudeUsage:refresh', (_event, args) => claudeUsage.refresh(args?.force ?? false));
    ipcMain.handle('claudeUsage:getSummary', (_event, args) => claudeUsage.getSummary(args.scope, args.range));
    ipcMain.handle('claudeUsage:getDaily', (_event, args) => claudeUsage.getDaily(args.scope, args.range));
    ipcMain.handle('claudeUsage:getBreakdown', (_event, args) => claudeUsage.getBreakdown(args.scope, args.range, args.kind));
    ipcMain.handle('claudeUsage:getRecentSessions', (_event, args) => claudeUsage.getRecentSessions(args.scope, args.range, args.limit));
}
