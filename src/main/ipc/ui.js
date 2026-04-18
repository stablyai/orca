import { ipcMain } from 'electron';
export function registerUIHandlers(store) {
    ipcMain.handle('ui:get', () => {
        return store.getUI();
    });
    ipcMain.handle('ui:set', (_event, args) => {
        store.updateUI(args);
    });
}
