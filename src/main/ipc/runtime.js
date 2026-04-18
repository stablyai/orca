import { BrowserWindow, ipcMain } from 'electron';
export function registerRuntimeHandlers(runtime) {
    ipcMain.removeHandler('runtime:syncWindowGraph');
    ipcMain.removeHandler('runtime:getStatus');
    ipcMain.handle('runtime:syncWindowGraph', (event, graph) => {
        const window = BrowserWindow.fromWebContents(event.sender);
        if (!window) {
            throw new Error('Runtime graph sync must originate from a BrowserWindow');
        }
        return runtime.syncWindowGraph(window.id, graph);
    });
    ipcMain.handle('runtime:getStatus', () => {
        return runtime.getStatus();
    });
}
