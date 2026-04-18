import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TerminalHost } from './terminal-host';
function createMockSubprocess() {
    let onDataCb = null;
    let onExitCb = null;
    return {
        pid: 99999,
        write: vi.fn(),
        resize: vi.fn(),
        kill: vi.fn(() => {
            setTimeout(() => onExitCb?.(0), 5);
        }),
        forceKill: vi.fn(),
        signal: vi.fn(),
        onData(cb) {
            onDataCb = cb;
        },
        onExit(cb) {
            onExitCb = cb;
        },
        // Test helpers
        get _onDataCb() {
            return onDataCb;
        },
        get _onExitCb() {
            return onExitCb;
        }
    };
}
describe('TerminalHost', () => {
    let host;
    let spawnFn;
    let lastSubprocess;
    beforeEach(() => {
        spawnFn = vi.fn(() => {
            const sub = createMockSubprocess();
            lastSubprocess = sub;
            return sub;
        });
        host = new TerminalHost({ spawnSubprocess: spawnFn });
    });
    afterEach(() => {
        host.dispose();
    });
    describe('createOrAttach', () => {
        it('creates a new session when none exists', async () => {
            const result = await host.createOrAttach({
                sessionId: 'session-1',
                cols: 80,
                rows: 24,
                streamClient: { onData: vi.fn(), onExit: vi.fn() }
            });
            expect(result.isNew).toBe(true);
            expect(result.pid).toBe(99999);
            expect(spawnFn).toHaveBeenCalledOnce();
        });
        it('attaches to existing session', async () => {
            await host.createOrAttach({
                sessionId: 'session-1',
                cols: 80,
                rows: 24,
                streamClient: { onData: vi.fn(), onExit: vi.fn() }
            });
            const result = await host.createOrAttach({
                sessionId: 'session-1',
                cols: 80,
                rows: 24,
                streamClient: { onData: vi.fn(), onExit: vi.fn() }
            });
            expect(result.isNew).toBe(false);
            // Should not spawn a second subprocess
            expect(spawnFn).toHaveBeenCalledOnce();
        });
        it('returns snapshot when attaching to existing session', async () => {
            await host.createOrAttach({
                sessionId: 'session-1',
                cols: 80,
                rows: 24,
                streamClient: { onData: vi.fn(), onExit: vi.fn() }
            });
            const result = await host.createOrAttach({
                sessionId: 'session-1',
                cols: 80,
                rows: 24,
                streamClient: { onData: vi.fn(), onExit: vi.fn() }
            });
            expect(result.snapshot).toBeDefined();
            expect(result.snapshot?.cols).toBe(80);
        });
        it('passes cwd and env to spawn', async () => {
            await host.createOrAttach({
                sessionId: 'session-1',
                cols: 80,
                rows: 24,
                cwd: '/home/user',
                env: { FOO: 'bar' },
                streamClient: { onData: vi.fn(), onExit: vi.fn() }
            });
            expect(spawnFn).toHaveBeenCalledWith(expect.objectContaining({
                sessionId: 'session-1',
                cwd: '/home/user',
                env: { FOO: 'bar' }
            }));
        });
        it('queues startup commands through the session shell-ready barrier', async () => {
            await host.createOrAttach({
                sessionId: 'session-1',
                cols: 80,
                rows: 24,
                command: 'echo hello',
                shellReadySupported: true,
                streamClient: { onData: vi.fn(), onExit: vi.fn() }
            });
            expect(lastSubprocess.write).not.toHaveBeenCalled();
            lastSubprocess._onDataCb?.('\x1b]777;orca-shell-ready\x07');
            expect(lastSubprocess.write).toHaveBeenCalledWith('echo hello\n');
        });
    });
    describe('write', () => {
        it('forwards write to the session', async () => {
            await host.createOrAttach({
                sessionId: 'session-1',
                cols: 80,
                rows: 24,
                streamClient: { onData: vi.fn(), onExit: vi.fn() }
            });
            host.write('session-1', 'hello');
            expect(lastSubprocess.write).toHaveBeenCalledWith('hello');
        });
        it('throws for non-existent session', () => {
            expect(() => host.write('missing', 'data')).toThrow('Session not found');
        });
    });
    describe('resize', () => {
        it('forwards resize to the session', async () => {
            await host.createOrAttach({
                sessionId: 'session-1',
                cols: 80,
                rows: 24,
                streamClient: { onData: vi.fn(), onExit: vi.fn() }
            });
            host.resize('session-1', 120, 40);
            expect(lastSubprocess.resize).toHaveBeenCalledWith(120, 40);
        });
    });
    describe('kill', () => {
        it('kills the session and tombstones it', async () => {
            await host.createOrAttach({
                sessionId: 'session-1',
                cols: 80,
                rows: 24,
                streamClient: { onData: vi.fn(), onExit: vi.fn() }
            });
            host.kill('session-1');
            expect(lastSubprocess.kill).toHaveBeenCalled();
            expect(host.isKilled('session-1')).toBe(true);
        });
        it('throws for non-existent session', () => {
            expect(() => host.kill('missing')).toThrow('Session not found');
        });
    });
    describe('signal', () => {
        it('sends signal without entering kill state', async () => {
            await host.createOrAttach({
                sessionId: 'session-1',
                cols: 80,
                rows: 24,
                streamClient: { onData: vi.fn(), onExit: vi.fn() }
            });
            host.signal('session-1', 'SIGINT');
            expect(lastSubprocess.signal).toHaveBeenCalledWith('SIGINT');
            expect(host.isKilled('session-1')).toBe(false);
        });
    });
    describe('listSessions', () => {
        it('returns empty list initially', () => {
            expect(host.listSessions()).toEqual([]);
        });
        it('lists created sessions', async () => {
            await host.createOrAttach({
                sessionId: 'session-1',
                cols: 80,
                rows: 24,
                streamClient: { onData: vi.fn(), onExit: vi.fn() }
            });
            await host.createOrAttach({
                sessionId: 'session-2',
                cols: 120,
                rows: 40,
                streamClient: { onData: vi.fn(), onExit: vi.fn() }
            });
            const sessions = host.listSessions();
            expect(sessions).toHaveLength(2);
            expect(sessions.map((s) => s.sessionId).sort()).toEqual(['session-1', 'session-2']);
        });
    });
    describe('detach', () => {
        it('detaches a client from a session', async () => {
            const onData = vi.fn();
            const result = await host.createOrAttach({
                sessionId: 'session-1',
                cols: 80,
                rows: 24,
                streamClient: { onData, onExit: vi.fn() }
            });
            host.detach('session-1', result.attachToken);
            // Data after detach should not be received
            lastSubprocess._onDataCb?.('after detach');
            expect(onData).not.toHaveBeenCalled();
        });
    });
    describe('tombstones', () => {
        it('caps tombstones at limit', async () => {
            for (let i = 0; i < 1005; i++) {
                await host.createOrAttach({
                    sessionId: `session-${i}`,
                    cols: 80,
                    rows: 24,
                    streamClient: { onData: vi.fn(), onExit: vi.fn() }
                });
                host.kill(`session-${i}`);
            }
            // Oldest tombstones should be evicted
            expect(host.isKilled('session-0')).toBe(false);
            expect(host.isKilled('session-1004')).toBe(true);
        });
    });
    describe('dispose', () => {
        it('kills live subprocesses before disposing sessions', async () => {
            await host.createOrAttach({
                sessionId: 'session-1',
                cols: 80,
                rows: 24,
                streamClient: { onData: vi.fn(), onExit: vi.fn() }
            });
            host.dispose();
            expect(lastSubprocess.kill).toHaveBeenCalled();
        });
        it('does not list exited sessions', async () => {
            await host.createOrAttach({
                sessionId: 'session-1',
                cols: 80,
                rows: 24,
                streamClient: { onData: vi.fn(), onExit: vi.fn() }
            });
            lastSubprocess._onExitCb?.(0);
            expect(host.listSessions()).toEqual([]);
        });
    });
});
