/* oxlint-disable max-lines */
import { beforeEach, describe, expect, it, vi } from 'vitest';
const { shellOpenExternalMock, menuBuildFromTemplateMock, guestOffMock, guestOnMock, guestSetBackgroundThrottlingMock, guestSetWindowOpenHandlerMock, guestOpenDevToolsMock, webContentsFromIdMock, screenGetCursorScreenPointMock } = vi.hoisted(() => ({
    shellOpenExternalMock: vi.fn(),
    menuBuildFromTemplateMock: vi.fn(),
    guestOffMock: vi.fn(),
    guestOnMock: vi.fn(),
    guestSetBackgroundThrottlingMock: vi.fn(),
    guestSetWindowOpenHandlerMock: vi.fn(),
    guestOpenDevToolsMock: vi.fn(),
    webContentsFromIdMock: vi.fn(),
    screenGetCursorScreenPointMock: vi.fn(() => ({ x: 0, y: 0 }))
}));
vi.mock('electron', () => ({
    clipboard: { writeText: vi.fn() },
    shell: { openExternal: shellOpenExternalMock },
    Menu: {
        buildFromTemplate: menuBuildFromTemplateMock
    },
    screen: {
        getCursorScreenPoint: screenGetCursorScreenPointMock
    },
    webContents: {
        fromId: webContentsFromIdMock
    }
}));
import { browserManager } from './browser-manager';
describe('browserManager', () => {
    const rendererWebContentsId = 5001;
    beforeEach(() => {
        shellOpenExternalMock.mockReset();
        menuBuildFromTemplateMock.mockReset();
        guestOffMock.mockReset();
        guestOnMock.mockReset();
        guestSetBackgroundThrottlingMock.mockReset();
        guestSetWindowOpenHandlerMock.mockReset();
        guestOpenDevToolsMock.mockReset();
        webContentsFromIdMock.mockReset();
        browserManager.unregisterAll();
    });
    it('validates popup URLs before opening externally', () => {
        const guest = {
            isDestroyed: vi.fn(() => false),
            getType: vi.fn(() => 'webview'),
            setBackgroundThrottling: guestSetBackgroundThrottlingMock,
            setWindowOpenHandler: guestSetWindowOpenHandlerMock,
            on: guestOnMock,
            off: guestOffMock,
            openDevTools: guestOpenDevToolsMock
        };
        webContentsFromIdMock.mockReturnValue(guest);
        browserManager.attachGuestPolicies(guest);
        const handler = guestSetWindowOpenHandlerMock.mock.calls[0][0];
        expect(handler({ url: 'localhost:3000' })).toEqual({ action: 'deny' });
        expect(handler({ url: 'file:///etc/passwd' })).toEqual({ action: 'deny' });
        expect(shellOpenExternalMock).toHaveBeenCalledTimes(1);
        expect(shellOpenExternalMock).toHaveBeenCalledWith('http://localhost:3000/');
    });
    it('routes safe popup URLs into a new Orca browser tab for the owning renderer', () => {
        const rendererSendMock = vi.fn();
        const guest = {
            id: 103,
            isDestroyed: vi.fn(() => false),
            getType: vi.fn(() => 'webview'),
            setBackgroundThrottling: guestSetBackgroundThrottlingMock,
            setWindowOpenHandler: guestSetWindowOpenHandlerMock,
            on: guestOnMock,
            off: guestOffMock,
            openDevTools: guestOpenDevToolsMock
        };
        webContentsFromIdMock.mockImplementation((id) => {
            if (id === guest.id) {
                return guest;
            }
            if (id === rendererWebContentsId) {
                return { isDestroyed: vi.fn(() => false), send: rendererSendMock };
            }
            return null;
        });
        browserManager.attachGuestPolicies(guest);
        browserManager.registerGuest({
            browserPageId: 'browser-1',
            webContentsId: guest.id,
            rendererWebContentsId
        });
        const handler = guestSetWindowOpenHandlerMock.mock.calls[0][0];
        expect(handler({ url: 'https://example.com/login' })).toEqual({ action: 'deny' });
        expect(shellOpenExternalMock).not.toHaveBeenCalled();
        expect(rendererSendMock).toHaveBeenCalledWith('browser:open-link-in-orca-tab', {
            browserPageId: 'browser-1',
            url: 'https://example.com/login'
        });
        expect(rendererSendMock).toHaveBeenCalledWith('browser:popup', {
            browserPageId: 'browser-1',
            origin: 'https://example.com',
            action: 'opened-in-orca'
        });
    });
    it('falls back to opening popup URLs externally before a guest is registered', () => {
        const guest = {
            id: 105,
            isDestroyed: vi.fn(() => false),
            getType: vi.fn(() => 'webview'),
            setBackgroundThrottling: guestSetBackgroundThrottlingMock,
            setWindowOpenHandler: guestSetWindowOpenHandlerMock,
            on: guestOnMock,
            off: guestOffMock,
            openDevTools: guestOpenDevToolsMock
        };
        webContentsFromIdMock.mockReturnValue(guest);
        browserManager.attachGuestPolicies(guest);
        const handler = guestSetWindowOpenHandlerMock.mock.calls[0][0];
        expect(handler({ url: 'https://example.com/login' })).toEqual({ action: 'deny' });
        expect(shellOpenExternalMock).toHaveBeenCalledWith('https://example.com/login');
    });
    it('offers opening a link in another Orca browser tab from the guest context menu', () => {
        const rendererSendMock = vi.fn();
        const guest = {
            id: 104,
            isDestroyed: vi.fn(() => false),
            getType: vi.fn(() => 'webview'),
            setBackgroundThrottling: guestSetBackgroundThrottlingMock,
            setWindowOpenHandler: guestSetWindowOpenHandlerMock,
            on: guestOnMock,
            off: guestOffMock,
            openDevTools: guestOpenDevToolsMock,
            getURL: vi.fn(() => 'https://example.com'),
            canGoBack: vi.fn(() => false),
            canGoForward: vi.fn(() => false),
            reload: vi.fn()
        };
        webContentsFromIdMock.mockImplementation((id) => {
            if (id === guest.id) {
                return guest;
            }
            if (id === rendererWebContentsId) {
                return { isDestroyed: vi.fn(() => false), send: rendererSendMock };
            }
            return null;
        });
        browserManager.attachGuestPolicies(guest);
        browserManager.registerGuest({
            browserPageId: 'browser-1',
            webContentsId: guest.id,
            rendererWebContentsId
        });
        const contextMenuHandler = guestOnMock.mock.calls.find(([event]) => event === 'context-menu')?.[1];
        contextMenuHandler?.({}, { linkURL: 'https://example.com/docs' });
        expect(rendererSendMock).toHaveBeenCalledWith('browser:context-menu-requested', expect.objectContaining({
            browserPageId: 'browser-1',
            pageUrl: 'https://example.com',
            linkUrl: 'https://example.com/docs',
            canGoBack: false,
            canGoForward: false
        }));
    });
    it('blocks non-web guest navigations after attach', () => {
        const guest = {
            isDestroyed: vi.fn(() => false),
            getType: vi.fn(() => 'webview'),
            setBackgroundThrottling: guestSetBackgroundThrottlingMock,
            setWindowOpenHandler: guestSetWindowOpenHandlerMock,
            on: guestOnMock,
            off: guestOffMock,
            openDevTools: guestOpenDevToolsMock
        };
        webContentsFromIdMock.mockReturnValue(guest);
        browserManager.attachGuestPolicies(guest);
        const willNavigateHandler = guestOnMock.mock.calls.find(([event]) => event === 'will-navigate')?.[1];
        expect(willNavigateHandler).toBeTypeOf('function');
        const preventDefault = vi.fn();
        willNavigateHandler?.({ preventDefault }, 'file:///etc/passwd');
        expect(preventDefault).toHaveBeenCalledTimes(1);
    });
    it('unregisterAll clears tracked guests and context-menu listeners', () => {
        const guest = {
            id: 101,
            isDestroyed: vi.fn(() => false),
            getType: vi.fn(() => 'webview'),
            setBackgroundThrottling: guestSetBackgroundThrottlingMock,
            setWindowOpenHandler: guestSetWindowOpenHandlerMock,
            on: guestOnMock,
            off: guestOffMock,
            openDevTools: guestOpenDevToolsMock
        };
        webContentsFromIdMock.mockReturnValue(guest);
        browserManager.attachGuestPolicies(guest);
        browserManager.registerGuest({
            browserPageId: 'browser-1',
            webContentsId: 101,
            // Why: registrations now record which renderer owns each guest so main
            // can route load failures back to the correct window instead of dropping
            // them once multiple renderers exist.
            rendererWebContentsId
        });
        browserManager.attachGuestPolicies({ ...guest, id: 102 });
        browserManager.registerGuest({
            browserPageId: 'browser-2',
            webContentsId: 102,
            rendererWebContentsId
        });
        browserManager.unregisterAll();
        expect(browserManager.getGuestWebContentsId('browser-1')).toBeNull();
        expect(browserManager.getGuestWebContentsId('browser-2')).toBeNull();
        expect(guestOffMock).toHaveBeenCalled();
    });
    it('rejects non-webview guest types to prevent privilege escalation', () => {
        // A compromised renderer could send the main window's own webContentsId.
        // registerGuest must reject it because getType() would return 'window',
        // not 'webview'.
        const mainWindowContents = {
            isDestroyed: vi.fn(() => false),
            getType: vi.fn(() => 'window'),
            setBackgroundThrottling: guestSetBackgroundThrottlingMock,
            setWindowOpenHandler: guestSetWindowOpenHandlerMock,
            on: guestOnMock,
            off: guestOffMock,
            openDevTools: guestOpenDevToolsMock
        };
        webContentsFromIdMock.mockReturnValue(mainWindowContents);
        browserManager.registerGuest({
            browserPageId: 'browser-evil',
            webContentsId: 1,
            rendererWebContentsId
        });
        // The guest should NOT be registered
        expect(browserManager.getGuestWebContentsId('browser-evil')).toBeNull();
        // setWindowOpenHandler must NOT have been called on the main window's webContents
        expect(guestSetWindowOpenHandlerMock).not.toHaveBeenCalled();
    });
    it('rejects registration for guests that never received attach-time policy wiring', () => {
        const guest = {
            id: 777,
            isDestroyed: vi.fn(() => false),
            getType: vi.fn(() => 'webview'),
            setBackgroundThrottling: guestSetBackgroundThrottlingMock,
            setWindowOpenHandler: guestSetWindowOpenHandlerMock,
            on: guestOnMock,
            off: guestOffMock,
            openDevTools: guestOpenDevToolsMock
        };
        webContentsFromIdMock.mockReturnValue(guest);
        browserManager.registerGuest({
            browserPageId: 'browser-1',
            webContentsId: 777,
            rendererWebContentsId
        });
        expect(browserManager.getGuestWebContentsId('browser-1')).toBeNull();
        expect(menuBuildFromTemplateMock).not.toHaveBeenCalled();
    });
    it('does not duplicate guest policy listeners when attach is reported twice', () => {
        const guest = {
            id: 303,
            isDestroyed: vi.fn(() => false),
            getType: vi.fn(() => 'webview'),
            setBackgroundThrottling: guestSetBackgroundThrottlingMock,
            setWindowOpenHandler: guestSetWindowOpenHandlerMock,
            on: guestOnMock,
            off: guestOffMock,
            openDevTools: guestOpenDevToolsMock
        };
        browserManager.attachGuestPolicies(guest);
        browserManager.attachGuestPolicies(guest);
        expect(guestSetBackgroundThrottlingMock).toHaveBeenCalledTimes(1);
        expect(guestSetWindowOpenHandlerMock).toHaveBeenCalledTimes(1);
        expect(guestOnMock.mock.calls.filter(([event]) => event === 'will-navigate')).toHaveLength(1);
        expect(guestOnMock.mock.calls.filter(([event]) => event === 'will-redirect')).toHaveLength(1);
    });
    it('replays a queued main-frame load failure after the guest registers', () => {
        const rendererSendMock = vi.fn();
        const guest = {
            id: 404,
            isDestroyed: vi.fn(() => false),
            getType: vi.fn(() => 'webview'),
            setBackgroundThrottling: guestSetBackgroundThrottlingMock,
            setWindowOpenHandler: guestSetWindowOpenHandlerMock,
            on: guestOnMock,
            off: guestOffMock,
            openDevTools: guestOpenDevToolsMock,
            getURL: vi.fn(() => 'http://localhost:3000/')
        };
        webContentsFromIdMock.mockImplementation((id) => {
            if (id === 404) {
                return guest;
            }
            if (id === rendererWebContentsId) {
                return {
                    isDestroyed: vi.fn(() => false),
                    send: rendererSendMock
                };
            }
            return null;
        });
        browserManager.attachGuestPolicies(guest);
        const didFailLoadHandler = guestOnMock.mock.calls.find(([event]) => event === 'did-fail-load')?.[1];
        expect(didFailLoadHandler).toBeTypeOf('function');
        didFailLoadHandler?.(null, -105, 'Name not resolved', 'http://localhost:3000/', true);
        expect(rendererSendMock).not.toHaveBeenCalled();
        browserManager.registerGuest({
            browserPageId: 'browser-1',
            webContentsId: 404,
            rendererWebContentsId
        });
        expect(rendererSendMock).toHaveBeenCalledTimes(1);
        expect(rendererSendMock).toHaveBeenCalledWith('browser:guest-load-failed', {
            browserPageId: 'browser-1',
            loadError: {
                code: -105,
                description: 'Name not resolved',
                validatedUrl: 'http://localhost:3000/'
            }
        });
    });
    it('queues permission denials and download requests until the guest registers', () => {
        const rendererSendMock = vi.fn();
        const guest = {
            id: 407,
            isDestroyed: vi.fn(() => false),
            getType: vi.fn(() => 'webview'),
            setBackgroundThrottling: guestSetBackgroundThrottlingMock,
            setWindowOpenHandler: guestSetWindowOpenHandlerMock,
            on: guestOnMock,
            off: guestOffMock,
            openDevTools: guestOpenDevToolsMock
        };
        const item = {
            pause: vi.fn(),
            getFilename: vi.fn(() => 'report.csv'),
            getTotalBytes: vi.fn(() => 2048),
            getMimeType: vi.fn(() => 'text/csv'),
            getURL: vi.fn(() => 'https://example.com/report.csv')
        };
        webContentsFromIdMock.mockImplementation((id) => {
            if (id === guest.id) {
                return guest;
            }
            if (id === rendererWebContentsId) {
                return { isDestroyed: vi.fn(() => false), send: rendererSendMock };
            }
            return null;
        });
        browserManager.attachGuestPolicies(guest);
        browserManager.notifyPermissionDenied({
            guestWebContentsId: guest.id,
            permission: 'media',
            rawUrl: 'https://example.com/account'
        });
        browserManager.handleGuestWillDownload({ guestWebContentsId: guest.id, item: item });
        expect(rendererSendMock).not.toHaveBeenCalled();
        browserManager.registerGuest({
            browserPageId: 'browser-1',
            webContentsId: guest.id,
            rendererWebContentsId
        });
        expect(rendererSendMock).toHaveBeenCalledWith('browser:permission-denied', {
            browserPageId: 'browser-1',
            permission: 'media',
            origin: 'https://example.com'
        });
        expect(rendererSendMock).toHaveBeenCalledWith('browser:download-requested', expect.objectContaining({
            browserPageId: 'browser-1',
            filename: 'report.csv',
            origin: 'https://example.com',
            totalBytes: 2048,
            mimeType: 'text/csv'
        }));
    });
    it('does not forward ctrl/cmd+r or readline chords from browser guests', () => {
        const rendererSendMock = vi.fn();
        const guest = {
            id: 405,
            isDestroyed: vi.fn(() => false),
            getType: vi.fn(() => 'webview'),
            setBackgroundThrottling: guestSetBackgroundThrottlingMock,
            setWindowOpenHandler: guestSetWindowOpenHandlerMock,
            on: guestOnMock,
            off: guestOffMock,
            openDevTools: guestOpenDevToolsMock
        };
        webContentsFromIdMock.mockImplementation((id) => {
            if (id === guest.id) {
                return guest;
            }
            if (id === rendererWebContentsId) {
                return { isDestroyed: vi.fn(() => false), send: rendererSendMock };
            }
            return null;
        });
        browserManager.attachGuestPolicies(guest);
        browserManager.registerGuest({
            browserPageId: 'browser-1',
            webContentsId: guest.id,
            rendererWebContentsId
        });
        const beforeInputHandler = guestOnMock.mock.calls
            .filter(([event]) => event === 'before-input-event')
            .at(-1)?.[1];
        expect(beforeInputHandler).toBeTypeOf('function');
        // Why: on Linux, Ctrl is the shortcut modifier, so Ctrl+R is the reload
        // shortcut (not a readline chord). Only test Ctrl+R as a readline passthrough
        // on macOS where Cmd is the modifier and Ctrl+R is genuinely a readline chord.
        const readlineChords = [
            ...(process.platform === 'darwin'
                ? [
                    {
                        type: 'keyDown',
                        code: 'KeyR',
                        key: 'r',
                        meta: false,
                        control: true,
                        alt: false,
                        shift: false
                    }
                ]
                : []),
            {
                type: 'keyDown',
                code: 'KeyU',
                key: 'u',
                meta: false,
                control: true,
                alt: false,
                shift: false
            },
            {
                type: 'keyDown',
                code: 'KeyE',
                key: 'e',
                meta: false,
                control: true,
                alt: false,
                shift: false
            },
            {
                type: 'keyDown',
                code: 'KeyJ',
                key: 'j',
                meta: false,
                control: true,
                alt: false,
                shift: false
            }
        ];
        for (const input of readlineChords) {
            const preventDefault = vi.fn();
            beforeInputHandler?.({ preventDefault }, input);
            expect(preventDefault).not.toHaveBeenCalled();
        }
        expect(rendererSendMock).not.toHaveBeenCalled();
    });
    it('forwards browser guest tab shortcuts alongside shared window shortcuts', () => {
        const isDarwin = process.platform === 'darwin';
        const rendererSendMock = vi.fn();
        const guest = {
            id: 406,
            isDestroyed: vi.fn(() => false),
            getType: vi.fn(() => 'webview'),
            setBackgroundThrottling: guestSetBackgroundThrottlingMock,
            setWindowOpenHandler: guestSetWindowOpenHandlerMock,
            on: guestOnMock,
            off: guestOffMock,
            openDevTools: guestOpenDevToolsMock
        };
        webContentsFromIdMock.mockImplementation((id) => {
            if (id === guest.id) {
                return guest;
            }
            if (id === rendererWebContentsId) {
                return { isDestroyed: vi.fn(() => false), send: rendererSendMock };
            }
            return null;
        });
        browserManager.attachGuestPolicies(guest);
        browserManager.registerGuest({
            browserPageId: 'browser-1',
            webContentsId: guest.id,
            rendererWebContentsId
        });
        const beforeInputHandler = guestOnMock.mock.calls
            .filter(([event]) => event === 'before-input-event')
            .at(-1)?.[1];
        expect(beforeInputHandler).toBeTypeOf('function');
        const inputs = [
            {
                type: 'keyDown',
                code: 'KeyB',
                key: 'b',
                meta: isDarwin,
                control: !isDarwin,
                alt: false,
                shift: true
            },
            {
                type: 'keyDown',
                code: 'KeyT',
                key: 't',
                meta: isDarwin,
                control: !isDarwin,
                alt: false,
                shift: false
            },
            {
                type: 'keyDown',
                code: 'KeyW',
                key: 'w',
                meta: isDarwin,
                control: !isDarwin,
                alt: false,
                shift: false
            },
            {
                type: 'keyDown',
                code: 'BracketRight',
                key: '}',
                meta: isDarwin,
                control: !isDarwin,
                alt: false,
                shift: true
            },
            {
                type: 'keyDown',
                code: 'KeyP',
                key: 'p',
                meta: isDarwin,
                control: !isDarwin,
                alt: false,
                shift: false
            },
            {
                type: 'keyDown',
                code: 'KeyL',
                key: 'l',
                meta: isDarwin,
                control: !isDarwin,
                alt: false,
                shift: false
            },
            {
                type: 'keyDown',
                code: 'KeyR',
                key: 'r',
                meta: isDarwin,
                control: !isDarwin,
                alt: false,
                shift: false
            },
            {
                type: 'keyDown',
                code: 'KeyR',
                key: 'r',
                meta: isDarwin,
                control: !isDarwin,
                alt: false,
                shift: true
            }
        ];
        for (const input of inputs) {
            const preventDefault = vi.fn();
            beforeInputHandler?.({ preventDefault }, input);
            expect(preventDefault).toHaveBeenCalledTimes(1);
        }
        expect(rendererSendMock).toHaveBeenNthCalledWith(1, 'ui:newBrowserTab');
        expect(rendererSendMock).toHaveBeenNthCalledWith(2, 'ui:newBrowserTab');
        expect(rendererSendMock).toHaveBeenNthCalledWith(3, 'ui:closeActiveTab');
        expect(rendererSendMock).toHaveBeenNthCalledWith(4, 'ui:switchTab', 1);
        expect(rendererSendMock).toHaveBeenNthCalledWith(5, 'ui:openQuickOpen');
        expect(rendererSendMock).toHaveBeenNthCalledWith(6, 'ui:focusBrowserAddressBar');
        expect(rendererSendMock).toHaveBeenNthCalledWith(7, 'ui:reloadBrowserPage');
        expect(rendererSendMock).toHaveBeenNthCalledWith(8, 'ui:hardReloadBrowserPage');
    });
    it('cleans up prior guest listeners before re-registering the same tab', () => {
        const guest = {
            id: 808,
            isDestroyed: vi.fn(() => false),
            getType: vi.fn(() => 'webview'),
            setBackgroundThrottling: guestSetBackgroundThrottlingMock,
            setWindowOpenHandler: guestSetWindowOpenHandlerMock,
            on: guestOnMock,
            off: guestOffMock,
            openDevTools: guestOpenDevToolsMock,
            getURL: vi.fn(() => 'https://example.com/'),
            canGoBack: vi.fn(() => false),
            canGoForward: vi.fn(() => false),
            goBack: vi.fn(),
            goForward: vi.fn(),
            reload: vi.fn(),
            executeJavaScript: vi.fn()
        };
        webContentsFromIdMock.mockReturnValue(guest);
        browserManager.attachGuestPolicies(guest);
        browserManager.registerGuest({
            browserPageId: 'browser-1',
            webContentsId: 808,
            rendererWebContentsId
        });
        guestOffMock.mockClear();
        browserManager.registerGuest({
            browserPageId: 'browser-1',
            webContentsId: 808,
            rendererWebContentsId
        });
        expect(guestOffMock).toHaveBeenCalledWith('context-menu', expect.any(Function));
        expect(guestOffMock.mock.calls.filter(([eventName]) => eventName === 'before-input-event')).toHaveLength(2);
    });
});
