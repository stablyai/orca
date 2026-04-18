import { ipcMain } from 'electron';
import { CliInstaller } from '../cli/cli-installer';
export function registerCliHandlers() {
    ipcMain.handle('cli:getInstallStatus', async () => {
        return new CliInstaller().getStatus();
    });
    ipcMain.handle('cli:install', async () => {
        return new CliInstaller().install();
    });
    ipcMain.handle('cli:remove', async () => {
        return new CliInstaller().remove();
    });
}
