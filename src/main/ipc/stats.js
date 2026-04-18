import { ipcMain } from 'electron';
export function registerStatsHandlers(stats) {
    ipcMain.handle('stats:summary', () => {
        return stats.getSummary();
    });
}
