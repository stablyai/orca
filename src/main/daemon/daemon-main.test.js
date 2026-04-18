import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tmpdir } from 'os';
import { join } from 'path';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs';
import { startDaemon } from './daemon-main';
import { DaemonClient } from './client';
function createTestDir() {
    return mkdtempSync(join(tmpdir(), 'daemon-main-test-'));
}
describe('startDaemon', () => {
    let dir;
    let socketPath;
    let tokenPath;
    let daemon = null;
    beforeEach(() => {
        dir = createTestDir();
        socketPath = join(dir, 'test.sock');
        tokenPath = join(dir, 'test.token');
    });
    afterEach(async () => {
        await daemon?.shutdown();
        daemon = null;
        rmSync(dir, { recursive: true, force: true });
    });
    it('creates token file and starts listening', async () => {
        daemon = await startDaemon({
            socketPath,
            tokenPath,
            spawnSubprocess: () => createMockSubprocess()
        });
        expect(existsSync(tokenPath)).toBe(true);
        const token = readFileSync(tokenPath, 'utf-8');
        expect(token.length).toBeGreaterThan(0);
    });
    it('accepts client connections', async () => {
        daemon = await startDaemon({
            socketPath,
            tokenPath,
            spawnSubprocess: () => createMockSubprocess()
        });
        const client = new DaemonClient({ socketPath, tokenPath });
        await client.ensureConnected();
        expect(client.isConnected()).toBe(true);
        client.disconnect();
    });
    it('handles session creation via connected client', async () => {
        daemon = await startDaemon({
            socketPath,
            tokenPath,
            spawnSubprocess: () => createMockSubprocess()
        });
        const client = new DaemonClient({ socketPath, tokenPath });
        await client.ensureConnected();
        const result = await client.request('createOrAttach', {
            sessionId: 'test-session',
            cols: 80,
            rows: 24
        });
        expect(result.isNew).toBe(true);
        expect(result.pid).toBe(99999);
        client.disconnect();
    });
    it('shuts down cleanly', async () => {
        daemon = await startDaemon({
            socketPath,
            tokenPath,
            spawnSubprocess: () => createMockSubprocess()
        });
        await daemon.shutdown();
        daemon = null;
        // Server should no longer accept connections
        const client = new DaemonClient({ socketPath, tokenPath });
        await expect(client.ensureConnected()).rejects.toThrow();
    });
});
function createMockSubprocess() {
    let onExitCb = null;
    return {
        pid: 99999,
        write: vi.fn(),
        resize: vi.fn(),
        kill: vi.fn(() => setTimeout(() => onExitCb?.(0), 5)),
        forceKill: vi.fn(),
        signal: vi.fn(),
        onData(_cb) { },
        onExit(cb) {
            onExitCb = cb;
        }
    };
}
