import { ipcMain } from 'electron';
export function registerRateLimitHandlers(rateLimits) {
    ipcMain.handle('rateLimits:get', () => rateLimits.getState());
    ipcMain.handle('rateLimits:refresh', () => rateLimits.refresh());
    ipcMain.handle('rateLimits:setPollingInterval', (_event, ms) => rateLimits.setPollingInterval(ms));
}
