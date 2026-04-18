import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
const { mockPtySpawn, mockPtyInstance } = vi.hoisted(() => ({
    mockPtySpawn: vi.fn(),
    mockPtyInstance: {
        pid: 12345,
        onData: vi.fn(),
        onExit: vi.fn(),
        write: vi.fn(),
        resize: vi.fn(),
        kill: vi.fn(),
        clear: vi.fn()
    }
}));
vi.mock('node-pty', () => ({
    spawn: mockPtySpawn
}));
import { PtyHandler } from './pty-handler';
function createMockDispatcher() {
    const requestHandlers = new Map();
    const notificationHandlers = new Map();
    const notifications = [];
    const dispatcher = {
        onRequest: vi.fn((method, handler) => {
            requestHandlers.set(method, handler);
        }),
        onNotification: vi.fn((method, handler) => {
            notificationHandlers.set(method, handler);
        }),
        notify: vi.fn((method, params) => {
            notifications.push({ method, params });
        }),
        // Helpers for tests
        _requestHandlers: requestHandlers,
        _notificationHandlers: notificationHandlers,
        _notifications: notifications,
        async callRequest(method, params = {}) {
            const handler = requestHandlers.get(method);
            if (!handler) {
                throw new Error(`No handler for ${method}`);
            }
            return handler(params);
        },
        callNotification(method, params = {}) {
            const handler = notificationHandlers.get(method);
            if (!handler) {
                throw new Error(`No handler for ${method}`);
            }
            handler(params);
        }
    };
    return dispatcher;
}
describe('PtyHandler', () => {
    let dispatcher;
    let handler;
    beforeEach(() => {
        vi.useFakeTimers();
        mockPtySpawn.mockReset();
        mockPtyInstance.onData.mockReset();
        mockPtyInstance.onExit.mockReset();
        mockPtyInstance.write.mockReset();
        mockPtyInstance.resize.mockReset();
        mockPtyInstance.kill.mockReset();
        mockPtyInstance.clear.mockReset();
        mockPtySpawn.mockReturnValue({ ...mockPtyInstance });
        dispatcher = createMockDispatcher();
        handler = new PtyHandler(dispatcher);
    });
    afterEach(() => {
        handler.dispose();
        vi.useRealTimers();
    });
    it('registers all expected handlers', () => {
        const methods = Array.from(dispatcher._requestHandlers.keys());
        expect(methods).toContain('pty.spawn');
        expect(methods).toContain('pty.attach');
        expect(methods).toContain('pty.shutdown');
        expect(methods).toContain('pty.sendSignal');
        expect(methods).toContain('pty.getCwd');
        expect(methods).toContain('pty.getInitialCwd');
        expect(methods).toContain('pty.clearBuffer');
        expect(methods).toContain('pty.hasChildProcesses');
        expect(methods).toContain('pty.getForegroundProcess');
        expect(methods).toContain('pty.listProcesses');
        expect(methods).toContain('pty.getDefaultShell');
        const notifMethods = Array.from(dispatcher._notificationHandlers.keys());
        expect(notifMethods).toContain('pty.data');
        expect(notifMethods).toContain('pty.resize');
        expect(notifMethods).toContain('pty.ackData');
    });
    it('spawns a PTY and returns an id', async () => {
        const result = await dispatcher.callRequest('pty.spawn', { cols: 80, rows: 24 });
        expect(result).toEqual({ id: 'pty-1' });
        expect(mockPtySpawn).toHaveBeenCalled();
        expect(handler.activePtyCount).toBe(1);
    });
    it('increments PTY ids on each spawn', async () => {
        const r1 = await dispatcher.callRequest('pty.spawn', {});
        const r2 = await dispatcher.callRequest('pty.spawn', {});
        expect(r1.id).toBe('pty-1');
        expect(r2.id).toBe('pty-2');
    });
    it('forwards data from PTY to dispatcher notifications', async () => {
        let dataCallback;
        mockPtySpawn.mockReturnValue({
            ...mockPtyInstance,
            onData: vi.fn((cb) => {
                dataCallback = cb;
            }),
            onExit: vi.fn()
        });
        await dispatcher.callRequest('pty.spawn', {});
        expect(dataCallback).toBeDefined();
        dataCallback('hello world');
        expect(dispatcher.notify).toHaveBeenCalledWith('pty.data', { id: 'pty-1', data: 'hello world' });
    });
    it('notifies on PTY exit and removes from map', async () => {
        let exitCallback;
        mockPtySpawn.mockReturnValue({
            ...mockPtyInstance,
            onData: vi.fn(),
            onExit: vi.fn((cb) => {
                exitCallback = cb;
            })
        });
        await dispatcher.callRequest('pty.spawn', {});
        expect(handler.activePtyCount).toBe(1);
        exitCallback({ exitCode: 0 });
        expect(dispatcher.notify).toHaveBeenCalledWith('pty.exit', { id: 'pty-1', code: 0 });
        expect(handler.activePtyCount).toBe(0);
    });
    it('writes data to PTY via pty.data notification', async () => {
        const mockWrite = vi.fn();
        mockPtySpawn.mockReturnValue({
            ...mockPtyInstance,
            write: mockWrite,
            onData: vi.fn(),
            onExit: vi.fn()
        });
        await dispatcher.callRequest('pty.spawn', {});
        dispatcher.callNotification('pty.data', { id: 'pty-1', data: 'ls\n' });
        expect(mockWrite).toHaveBeenCalledWith('ls\n');
    });
    it('resizes PTY via pty.resize notification', async () => {
        const mockResize = vi.fn();
        mockPtySpawn.mockReturnValue({
            ...mockPtyInstance,
            resize: mockResize,
            onData: vi.fn(),
            onExit: vi.fn()
        });
        await dispatcher.callRequest('pty.spawn', {});
        dispatcher.callNotification('pty.resize', { id: 'pty-1', cols: 120, rows: 40 });
        expect(mockResize).toHaveBeenCalledWith(120, 40);
    });
    it('kills PTY on shutdown with SIGTERM by default', async () => {
        const mockKill = vi.fn();
        mockPtySpawn.mockReturnValue({
            ...mockPtyInstance,
            kill: mockKill,
            onData: vi.fn(),
            onExit: vi.fn()
        });
        await dispatcher.callRequest('pty.spawn', {});
        await dispatcher.callRequest('pty.shutdown', { id: 'pty-1', immediate: false });
        expect(mockKill).toHaveBeenCalledWith('SIGTERM');
    });
    it('kills PTY on shutdown with SIGKILL when immediate', async () => {
        const mockKill = vi.fn();
        mockPtySpawn.mockReturnValue({
            ...mockPtyInstance,
            kill: mockKill,
            onData: vi.fn(),
            onExit: vi.fn()
        });
        await dispatcher.callRequest('pty.spawn', {});
        await dispatcher.callRequest('pty.shutdown', { id: 'pty-1', immediate: true });
        expect(mockKill).toHaveBeenCalledWith('SIGKILL');
    });
    it('throws for attach on nonexistent PTY', async () => {
        await expect(dispatcher.callRequest('pty.attach', { id: 'pty-999' })).rejects.toThrow('PTY "pty-999" not found');
    });
    it('grace timer fires immediately when no PTYs exist', () => {
        const onExpire = vi.fn();
        handler.startGraceTimer(onExpire);
        expect(onExpire).toHaveBeenCalledTimes(1);
    });
    it('grace timer fires after configured delay when PTYs exist', async () => {
        mockPtySpawn.mockReturnValue({
            ...mockPtyInstance,
            onData: vi.fn(),
            onExit: vi.fn()
        });
        await dispatcher.callRequest('pty.spawn', {});
        const onExpire = vi.fn();
        handler.startGraceTimer(onExpire);
        expect(onExpire).not.toHaveBeenCalled();
        vi.advanceTimersByTime(5 * 60 * 1000);
        expect(onExpire).toHaveBeenCalledTimes(1);
    });
    it('cancelGraceTimer prevents expiration', async () => {
        mockPtySpawn.mockReturnValue({
            ...mockPtyInstance,
            onData: vi.fn(),
            onExit: vi.fn()
        });
        await dispatcher.callRequest('pty.spawn', {});
        const onExpire = vi.fn();
        handler.startGraceTimer(onExpire);
        vi.advanceTimersByTime(60_000);
        handler.cancelGraceTimer();
        vi.advanceTimersByTime(5 * 60 * 1000);
        expect(onExpire).not.toHaveBeenCalled();
    });
    it('dispose kills all PTYs', async () => {
        const mockKill = vi.fn();
        mockPtySpawn.mockReturnValue({
            ...mockPtyInstance,
            kill: mockKill,
            onData: vi.fn(),
            onExit: vi.fn()
        });
        await dispatcher.callRequest('pty.spawn', {});
        await dispatcher.callRequest('pty.spawn', {});
        expect(handler.activePtyCount).toBe(2);
        handler.dispose();
        expect(mockKill).toHaveBeenCalledWith('SIGTERM');
        expect(handler.activePtyCount).toBe(0);
    });
});
