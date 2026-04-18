import { ipcMain } from 'electron';
export function registerSessionHandlers(store) {
    ipcMain.handle('session:get', () => {
        return store.getWorkspaceSession();
    });
    ipcMain.handle('session:set', (_event, args) => {
        store.setWorkspaceSession(args);
    });
    // Synchronous variant for the renderer's beforeunload handler.
    // sendSync blocks the renderer until this returns, guaranteeing the
    // data (including terminal scrollback buffers) is persisted to disk
    // before the window closes — regardless of before-quit ordering.
    ipcMain.on('session:set-sync', (event, args) => {
        store.setWorkspaceSession(args);
        store.flush();
        event.returnValue = true;
    });
}
