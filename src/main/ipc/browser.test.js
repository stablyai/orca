import { beforeEach, describe, expect, it, vi } from 'vitest';
const { removeHandlerMock, handleMock, registerGuestMock, unregisterGuestMock, openDevToolsMock, getDownloadPromptMock, acceptDownloadMock, cancelDownloadMock, showSaveDialogMock, browserWindowFromWebContentsMock } = vi.hoisted(() => ({
    removeHandlerMock: vi.fn(),
    handleMock: vi.fn(),
    registerGuestMock: vi.fn(),
    unregisterGuestMock: vi.fn(),
    openDevToolsMock: vi.fn().mockResolvedValue(true),
    getDownloadPromptMock: vi.fn(),
    acceptDownloadMock: vi.fn(),
    cancelDownloadMock: vi.fn(),
    showSaveDialogMock: vi.fn(),
    browserWindowFromWebContentsMock: vi.fn()
}));
vi.mock('electron', () => ({
    BrowserWindow: {
        fromWebContents: browserWindowFromWebContentsMock
    },
    dialog: {
        showSaveDialog: showSaveDialogMock
    },
    ipcMain: {
        removeHandler: removeHandlerMock,
        handle: handleMock
    }
}));
vi.mock('../browser/browser-manager', () => ({
    browserManager: {
        registerGuest: registerGuestMock,
        unregisterGuest: unregisterGuestMock,
        openDevTools: openDevToolsMock,
        getDownloadPrompt: getDownloadPromptMock,
        acceptDownload: acceptDownloadMock,
        cancelDownload: cancelDownloadMock
    }
}));
import { registerBrowserHandlers } from './browser';
describe('registerBrowserHandlers', () => {
    beforeEach(() => {
        removeHandlerMock.mockReset();
        handleMock.mockReset();
        registerGuestMock.mockReset();
        unregisterGuestMock.mockReset();
        openDevToolsMock.mockReset();
        getDownloadPromptMock.mockReset();
        acceptDownloadMock.mockReset();
        cancelDownloadMock.mockReset();
        showSaveDialogMock.mockReset();
        browserWindowFromWebContentsMock.mockReset();
        openDevToolsMock.mockResolvedValue(true);
    });
    it('rejects non-window callers', async () => {
        registerBrowserHandlers();
        const registerHandler = handleMock.mock.calls.find(([channel]) => channel === 'browser:registerGuest')?.[1];
        const result = registerHandler({
            sender: {
                isDestroyed: () => false,
                getType: () => 'webview',
                getURL: () => 'http://localhost:5173/'
            }
        }, { browserTabId: 'browser-1', webContentsId: 101 });
        expect(result).toBe(false);
        expect(registerGuestMock).not.toHaveBeenCalled();
    });
    it('accepts downloads through a main-owned save dialog', async () => {
        getDownloadPromptMock.mockReturnValue({ filename: 'report.csv' });
        acceptDownloadMock.mockReturnValue({ ok: true });
        showSaveDialogMock.mockResolvedValue({ canceled: false, filePath: '/tmp/report.csv' });
        registerBrowserHandlers();
        const acceptHandler = handleMock.mock.calls.find(([channel]) => channel === 'browser:acceptDownload')?.[1];
        const sender = {
            id: 91,
            isDestroyed: () => false,
            getType: () => 'window',
            getURL: () => 'file:///renderer/index.html'
        };
        const result = await acceptHandler({ sender }, { downloadId: 'download-1' });
        expect(showSaveDialogMock).toHaveBeenCalledTimes(1);
        expect(acceptDownloadMock).toHaveBeenCalledWith({
            downloadId: 'download-1',
            senderWebContentsId: 91,
            savePath: '/tmp/report.csv'
        });
        expect(result).toEqual({ ok: true });
    });
});
