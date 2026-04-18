import { beforeEach, describe, expect, it, vi } from 'vitest';
const { onMock, removeAllListenersMock, setPermissionRequestHandlerMock, setPermissionCheckHandlerMock, setDisplayMediaRequestHandlerMock, registerRepoHandlersMock, registerWorktreeHandlersMock, registerPtyHandlersMock, setupAutoUpdaterMock, sessionFromPartitionMock, browserManagerUnregisterAllMock, browserManagerNotifyPermissionDeniedMock, browserManagerHandleGuestWillDownloadMock } = vi.hoisted(() => ({
    onMock: vi.fn(),
    removeAllListenersMock: vi.fn(),
    setPermissionRequestHandlerMock: vi.fn(),
    setPermissionCheckHandlerMock: vi.fn(),
    setDisplayMediaRequestHandlerMock: vi.fn(),
    registerRepoHandlersMock: vi.fn(),
    registerWorktreeHandlersMock: vi.fn(),
    registerPtyHandlersMock: vi.fn(),
    setupAutoUpdaterMock: vi.fn(),
    sessionFromPartitionMock: vi.fn(),
    browserManagerUnregisterAllMock: vi.fn(),
    browserManagerNotifyPermissionDeniedMock: vi.fn(),
    browserManagerHandleGuestWillDownloadMock: vi.fn()
}));
vi.mock('electron', () => ({
    app: {},
    clipboard: {},
    session: {
        fromPartition: sessionFromPartitionMock
    },
    ipcMain: {
        on: onMock,
        removeAllListeners: removeAllListenersMock,
        removeHandler: vi.fn(),
        handle: vi.fn()
    }
}));
vi.mock('../ipc/repos', () => ({
    registerRepoHandlers: registerRepoHandlersMock
}));
vi.mock('../ipc/worktrees', () => ({
    registerWorktreeHandlers: registerWorktreeHandlersMock
}));
vi.mock('../ipc/pty', () => ({
    registerPtyHandlers: registerPtyHandlersMock
}));
vi.mock('../browser/browser-manager', () => ({
    browserManager: {
        notifyPermissionDenied: browserManagerNotifyPermissionDeniedMock,
        handleGuestWillDownload: browserManagerHandleGuestWillDownloadMock,
        unregisterAll: browserManagerUnregisterAllMock
    }
}));
vi.mock('../updater', () => ({
    checkForUpdates: vi.fn(),
    getUpdateStatus: vi.fn(),
    quitAndInstall: vi.fn(),
    dismissNudge: vi.fn(),
    setupAutoUpdater: setupAutoUpdaterMock
}));
import { attachMainWindowServices } from './attach-main-window-services';
describe('attachMainWindowServices', () => {
    beforeEach(() => {
        onMock.mockReset();
        removeAllListenersMock.mockReset();
        setPermissionRequestHandlerMock.mockReset();
        setPermissionCheckHandlerMock.mockReset();
        setDisplayMediaRequestHandlerMock.mockReset();
        registerRepoHandlersMock.mockReset();
        registerWorktreeHandlersMock.mockReset();
        registerPtyHandlersMock.mockReset();
        setupAutoUpdaterMock.mockReset();
        sessionFromPartitionMock.mockReset();
        browserManagerUnregisterAllMock.mockReset();
        browserManagerNotifyPermissionDeniedMock.mockReset();
        browserManagerHandleGuestWillDownloadMock.mockReset();
        sessionFromPartitionMock.mockReturnValue({
            setPermissionRequestHandler: setPermissionRequestHandlerMock,
            setPermissionCheckHandler: setPermissionCheckHandlerMock,
            setDisplayMediaRequestHandler: setDisplayMediaRequestHandlerMock,
            on: vi.fn()
        });
    });
    it('only allows the explicit permission allowlist', () => {
        const mainWindow = {
            on: vi.fn(),
            webContents: {
                on: vi.fn(),
                session: {
                    setPermissionRequestHandler: setPermissionRequestHandlerMock
                }
            }
        };
        const store = { flush: vi.fn() };
        const runtime = {
            attachWindow: vi.fn(),
            setNotifier: vi.fn(),
            markRendererReloading: vi.fn(),
            markGraphUnavailable: vi.fn()
        };
        attachMainWindowServices(mainWindow, store, runtime);
        expect(setPermissionRequestHandlerMock).toHaveBeenCalledTimes(2);
        const permissionHandler = setPermissionRequestHandlerMock.mock.calls[0][0];
        const callback = vi.fn();
        permissionHandler(null, 'media', callback);
        permissionHandler(null, 'fullscreen', callback);
        permissionHandler(null, 'pointerLock', callback);
        permissionHandler(null, 'clipboard-read', callback);
        expect(callback.mock.calls).toEqual([[true], [true], [true], [false]]);
    });
    it('denies browser-session permissions, display capture, and downloads by default', () => {
        const browserSessionOnMock = vi.fn();
        sessionFromPartitionMock.mockReturnValue({
            setPermissionRequestHandler: setPermissionRequestHandlerMock,
            setPermissionCheckHandler: setPermissionCheckHandlerMock,
            setDisplayMediaRequestHandler: setDisplayMediaRequestHandlerMock,
            on: browserSessionOnMock
        });
        const mainWindowOnMock = vi.fn();
        const mainWindow = {
            on: mainWindowOnMock,
            webContents: {
                on: vi.fn(),
                session: {
                    setPermissionRequestHandler: setPermissionRequestHandlerMock
                }
            }
        };
        const store = { flush: vi.fn() };
        const runtime = {
            attachWindow: vi.fn(),
            setNotifier: vi.fn(),
            markRendererReloading: vi.fn(),
            markGraphUnavailable: vi.fn()
        };
        attachMainWindowServices(mainWindow, store, runtime);
        const browserPermissionHandler = setPermissionRequestHandlerMock.mock.calls[1][0];
        const permissionCallback = vi.fn();
        const guestWebContents = { id: 401, getURL: vi.fn(() => 'https://example.com/account') };
        browserPermissionHandler(guestWebContents, 'fullscreen', permissionCallback);
        browserPermissionHandler(guestWebContents, 'media', permissionCallback);
        expect(permissionCallback.mock.calls).toEqual([[true], [false]]);
        expect(browserManagerNotifyPermissionDeniedMock).toHaveBeenCalledTimes(1);
        expect(browserManagerNotifyPermissionDeniedMock).toHaveBeenCalledWith({
            guestWebContentsId: 401,
            permission: 'media',
            rawUrl: 'https://example.com/account'
        });
        const browserPermissionCheckHandler = setPermissionCheckHandlerMock.mock.calls[0][0];
        expect(browserPermissionCheckHandler(null, 'fullscreen')).toBe(true);
        expect(browserPermissionCheckHandler(null, 'notifications')).toBe(false);
        const displayMediaHandler = setDisplayMediaRequestHandlerMock.mock.calls[0][0];
        const displayCallback = vi.fn();
        displayMediaHandler(null, displayCallback);
        expect(displayCallback).toHaveBeenCalledWith({ video: undefined, audio: undefined });
        const willDownloadHandler = browserSessionOnMock.mock.calls.find(([eventName]) => eventName === 'will-download')?.[1];
        const item = { getFilename: vi.fn(() => 'report.pdf') };
        willDownloadHandler({}, item, { id: 402 });
        expect(browserManagerHandleGuestWillDownloadMock).toHaveBeenCalledTimes(1);
        expect(browserManagerHandleGuestWillDownloadMock).toHaveBeenCalledWith({
            guestWebContentsId: 402,
            item
        });
    });
    it('clears browser guest registrations when the main window closes', () => {
        sessionFromPartitionMock.mockReturnValue({
            setPermissionRequestHandler: setPermissionRequestHandlerMock,
            setPermissionCheckHandler: setPermissionCheckHandlerMock,
            setDisplayMediaRequestHandler: setDisplayMediaRequestHandlerMock,
            on: vi.fn()
        });
        const mainWindowOnMock = vi.fn();
        const mainWindow = {
            on: mainWindowOnMock,
            webContents: {
                on: vi.fn(),
                session: {
                    setPermissionRequestHandler: setPermissionRequestHandlerMock
                }
            }
        };
        const store = { flush: vi.fn() };
        const runtime = {
            attachWindow: vi.fn(),
            setNotifier: vi.fn(),
            markRendererReloading: vi.fn(),
            markGraphUnavailable: vi.fn()
        };
        attachMainWindowServices(mainWindow, store, runtime);
        const closedHandler = mainWindowOnMock.mock.calls
            .filter(([event]) => event === 'closed')
            .at(-1)?.[1];
        expect(closedHandler).toBeTypeOf('function');
        closedHandler?.();
        expect(browserManagerUnregisterAllMock).toHaveBeenCalledTimes(1);
    });
    it('forwards runtime notifier events to the renderer', () => {
        const sendMock = vi.fn();
        const webContentsOnMock = vi.fn();
        const mainWindowOnMock = vi.fn();
        const mainWindow = {
            isDestroyed: vi.fn(() => false),
            on: mainWindowOnMock,
            webContents: {
                on: webContentsOnMock,
                send: sendMock,
                session: {
                    setPermissionRequestHandler: setPermissionRequestHandlerMock
                }
            }
        };
        const store = { flush: vi.fn() };
        const runtime = {
            attachWindow: vi.fn(),
            setNotifier: vi.fn(),
            markRendererReloading: vi.fn(),
            markGraphUnavailable: vi.fn()
        };
        attachMainWindowServices(mainWindow, store, runtime);
        expect(runtime.setNotifier).toHaveBeenCalledTimes(1);
        const notifier = runtime.setNotifier.mock.calls[0][0];
        notifier.worktreesChanged('repo-1');
        notifier.reposChanged();
        notifier.activateWorktree('repo-1', 'wt-1', {
            runnerScriptPath: '/tmp/repo/.git/orca/setup-runner.sh',
            envVars: {
                ORCA_ROOT_PATH: '/tmp/repo',
                ORCA_WORKTREE_PATH: '/tmp/worktrees/wt-1'
            }
        });
        expect(sendMock.mock.calls).toEqual([
            ['worktrees:changed', { repoId: 'repo-1' }],
            ['repos:changed'],
            [
                'ui:activateWorktree',
                {
                    repoId: 'repo-1',
                    worktreeId: 'wt-1',
                    setup: {
                        runnerScriptPath: '/tmp/repo/.git/orca/setup-runner.sh',
                        envVars: {
                            ORCA_ROOT_PATH: '/tmp/repo',
                            ORCA_WORKTREE_PATH: '/tmp/worktrees/wt-1'
                        }
                    }
                }
            ]
        ]);
    });
});
