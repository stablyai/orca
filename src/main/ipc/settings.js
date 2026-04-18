import { ipcMain, nativeTheme } from 'electron';
import { listSystemFontFamilies } from '../system-fonts';
export function registerSettingsHandlers(store) {
    ipcMain.handle('settings:get', () => {
        return store.getSettings();
    });
    ipcMain.handle('settings:set', (_event, args) => {
        if (args.theme) {
            nativeTheme.themeSource = args.theme;
        }
        return store.updateSettings(args);
    });
    ipcMain.handle('settings:listFonts', () => {
        return listSystemFontFamilies();
    });
    ipcMain.handle('cache:getGitHub', () => {
        return store.getGitHubCache();
    });
    ipcMain.handle('cache:setGitHub', (_event, args) => {
        store.setGitHubCache(args.cache);
    });
}
