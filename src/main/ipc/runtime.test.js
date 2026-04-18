import { beforeEach, describe, expect, it, vi } from 'vitest';
const { handleMock, removeHandlerMock, fromWebContentsMock } = vi.hoisted(() => ({
    handleMock: vi.fn(),
    removeHandlerMock: vi.fn(),
    fromWebContentsMock: vi.fn()
}));
vi.mock('electron', () => ({
    BrowserWindow: {
        fromWebContents: fromWebContentsMock
    },
    ipcMain: {
        handle: handleMock,
        removeHandler: removeHandlerMock
    }
}));
import { registerRuntimeHandlers } from './runtime';
describe('registerRuntimeHandlers', () => {
    beforeEach(() => {
        handleMock.mockReset();
        removeHandlerMock.mockReset();
        fromWebContentsMock.mockReset();
    });
    it('routes sync requests through the authoritative browser window id', () => {
        const runtime = {
            syncWindowGraph: vi.fn().mockReturnValue({ graphStatus: 'ready' }),
            getStatus: vi.fn().mockReturnValue({ graphStatus: 'unavailable' })
        };
        registerRuntimeHandlers(runtime);
        const syncRegistration = handleMock.mock.calls.find(([channel]) => channel === 'runtime:syncWindowGraph');
        expect(syncRegistration).toBeTruthy();
        fromWebContentsMock.mockReturnValue({ id: 17 });
        const handler = syncRegistration[1];
        const result = handler({ sender: {} }, { tabs: [], leaves: [] });
        expect(runtime.syncWindowGraph).toHaveBeenCalledWith(17, { tabs: [], leaves: [] });
        expect(result).toEqual({ graphStatus: 'ready' });
    });
});
