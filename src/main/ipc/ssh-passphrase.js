import { ipcMain } from 'electron';
import { randomUUID } from 'crypto';
const CREDENTIAL_TIMEOUT_MS = 120_000;
const pendingRequests = new Map();
function notifyCredentialResolved(getMainWindow, requestId) {
    const win = getMainWindow();
    if (win && !win.isDestroyed()) {
        win.webContents.send('ssh:credential-resolved', { requestId });
    }
}
export function requestCredential(getMainWindow, targetId, kind, detail) {
    const requestId = randomUUID();
    return new Promise((resolve) => {
        const timer = setTimeout(() => {
            if (pendingRequests.delete(requestId)) {
                notifyCredentialResolved(getMainWindow, requestId);
                resolve(null);
            }
        }, CREDENTIAL_TIMEOUT_MS);
        pendingRequests.set(requestId, {
            resolve: (value) => {
                clearTimeout(timer);
                resolve(value);
            }
        });
        const win = getMainWindow();
        if (win && !win.isDestroyed()) {
            win.webContents.send('ssh:credential-request', { requestId, targetId, kind, detail });
        }
        else {
            pendingRequests.delete(requestId);
            clearTimeout(timer);
            notifyCredentialResolved(getMainWindow, requestId);
            resolve(null);
        }
    });
}
export function registerCredentialHandler(getMainWindow) {
    ipcMain.removeHandler('ssh:submitCredential');
    ipcMain.handle('ssh:submitCredential', (_event, args) => {
        const pending = pendingRequests.get(args.requestId);
        if (pending) {
            pendingRequests.delete(args.requestId);
            notifyCredentialResolved(getMainWindow, args.requestId);
            pending.resolve(args.value);
        }
    });
}
