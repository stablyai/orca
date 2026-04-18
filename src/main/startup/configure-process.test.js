import { join } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('electron', () => {
    const paths = new Map([['appData', '/tmp/app-data']]);
    return {
        app: {
            getPath: vi.fn((name) => paths.get(name) ?? ''),
            setPath: vi.fn((name, value) => {
                paths.set(name, value);
            }),
            quit: vi.fn(),
            exit: vi.fn(),
            commandLine: {
                appendSwitch: vi.fn()
            }
        }
    };
});
afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
});
describe('configureDevUserDataPath', () => {
    it('uses an explicit dev userData override when provided', async () => {
        const { app } = await import('electron');
        const { configureDevUserDataPath } = await import('./configure-process');
        const originalOverride = process.env.ORCA_DEV_USER_DATA_PATH;
        process.env.ORCA_DEV_USER_DATA_PATH = '/tmp/orca-dev-repro';
        try {
            configureDevUserDataPath(true);
        }
        finally {
            if (originalOverride === undefined) {
                delete process.env.ORCA_DEV_USER_DATA_PATH;
            }
            else {
                process.env.ORCA_DEV_USER_DATA_PATH = originalOverride;
            }
        }
        expect(app.setPath).toHaveBeenCalledWith('userData', '/tmp/orca-dev-repro');
    });
    it('moves dev runs onto an orca-dev userData path', async () => {
        const { app } = await import('electron');
        const { configureDevUserDataPath } = await import('./configure-process');
        delete process.env.ORCA_DEV_USER_DATA_PATH;
        configureDevUserDataPath(true);
        // Why: production code uses path.join(app.getPath('appData'), 'orca-dev')
        // which produces platform-specific separators.
        expect(app.setPath).toHaveBeenCalledWith('userData', join('/tmp/app-data', 'orca-dev'));
    });
    it('leaves packaged runs on the default userData path', async () => {
        const { app } = await import('electron');
        const { configureDevUserDataPath } = await import('./configure-process');
        vi.mocked(app.setPath).mockClear();
        configureDevUserDataPath(false);
        expect(app.setPath).not.toHaveBeenCalled();
    });
});
describe('installDevParentDisconnectQuit', () => {
    it('quits the dev app when the supervising IPC channel disconnects', async () => {
        const { app } = await import('electron');
        const { installDevParentDisconnectQuit } = await import('./configure-process');
        vi.useFakeTimers();
        const originalSend = process.send;
        const originalOnce = process.once.bind(process);
        const disconnectHandlers = [];
        process.send = (() => true);
        process.once = ((event, listener) => {
            if (event === 'disconnect') {
                disconnectHandlers.push(listener);
            }
            return process;
        });
        vi.mocked(app.quit).mockClear();
        try {
            installDevParentDisconnectQuit(true);
        }
        finally {
            process.send = originalSend;
            process.once = originalOnce;
        }
        expect(disconnectHandlers).toHaveLength(1);
        disconnectHandlers[0]();
        expect(app.quit).toHaveBeenCalledTimes(1);
        expect(app.exit).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(3000);
        expect(app.exit).toHaveBeenCalledWith(0);
    });
    it('does not register the disconnect hook outside dev ipc launches', async () => {
        const { installDevParentDisconnectQuit } = await import('./configure-process');
        const originalSend = process.send;
        const originalOnce = process.once.bind(process);
        const onceSpy = vi.fn(originalOnce);
        process.send = undefined;
        process.once = onceSpy;
        try {
            installDevParentDisconnectQuit(true);
            installDevParentDisconnectQuit(false);
        }
        finally {
            process.send = originalSend;
            process.once = originalOnce;
        }
        expect(onceSpy).not.toHaveBeenCalledWith('disconnect', expect.any(Function));
    });
});
describe('installDevParentWatchdog', () => {
    it('quits the dev app when the original parent pid disappears', async () => {
        const { app } = await import('electron');
        const { installDevParentWatchdog } = await import('./configure-process');
        vi.useFakeTimers();
        vi.mocked(app.quit).mockClear();
        vi.mocked(app.exit).mockClear();
        let parentExists = true;
        vi.spyOn(process, 'kill').mockImplementation(((pid, signal) => {
            if (signal === 0 && pid === 4242 && !parentExists) {
                const error = new Error('missing');
                error.code = 'ESRCH';
                throw error;
            }
            return true;
        }));
        const originalPpid = Object.getOwnPropertyDescriptor(process, 'ppid');
        Object.defineProperty(process, 'ppid', {
            configurable: true,
            get: () => 4242
        });
        try {
            installDevParentWatchdog(true);
            await vi.advanceTimersByTimeAsync(1000);
            expect(app.quit).not.toHaveBeenCalled();
            parentExists = false;
            await vi.advanceTimersByTimeAsync(1000);
            expect(app.quit).toHaveBeenCalledTimes(1);
            expect(app.exit).not.toHaveBeenCalled();
            await vi.advanceTimersByTimeAsync(3000);
            expect(app.exit).toHaveBeenCalledWith(0);
        }
        finally {
            if (originalPpid) {
                Object.defineProperty(process, 'ppid', originalPpid);
            }
        }
    });
    it('does not start the watchdog outside dev mode', async () => {
        const { installDevParentWatchdog } = await import('./configure-process');
        const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
        installDevParentWatchdog(false);
        expect(setIntervalSpy).not.toHaveBeenCalled();
    });
});
describe('enableMainProcessGpuFeatures', () => {
    it('appends Orca GPU flags by default', async () => {
        const { app } = await import('electron');
        const { enableMainProcessGpuFeatures } = await import('./configure-process');
        enableMainProcessGpuFeatures();
        expect(app.commandLine.appendSwitch).toHaveBeenCalledWith('enable-features', 'Vulkan,UseSkiaGraphite');
        expect(app.commandLine.appendSwitch).toHaveBeenCalledWith('enable-unsafe-webgpu');
    });
});
