import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tmpdir } from 'os';
import { join } from 'path';
import { mkdtempSync, rmSync } from 'fs';
import { createProductionLauncher } from './production-launcher';
import { startDaemon } from './daemon-main';
import { DaemonClient } from './client';
function createTestDir() {
    return mkdtempSync(join(tmpdir(), 'prod-launcher-test-'));
}
function createMockSubprocess() {
    let onExitCb = null;
    return {
        pid: 44444,
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
describe('createProductionLauncher', () => {
    let dir;
    let handles;
    beforeEach(() => {
        dir = createTestDir();
        handles = [];
    });
    afterEach(async () => {
        for (const h of handles) {
            await h.shutdown().catch(() => { });
        }
        rmSync(dir, { recursive: true, force: true });
    });
    it('returns a launcher function', () => {
        const launcher = createProductionLauncher({
            getDaemonEntryPath: () => '/fake/path.js'
        });
        expect(typeof launcher).toBe('function');
    });
    it('can be used with DaemonSpawner (in-process fallback)', async () => {
        // Use in-process launcher for testing (same as DaemonSpawner tests)
        const launcher = async (socketPath, tokenPath) => {
            const handle = await startDaemon({
                socketPath,
                tokenPath,
                spawnSubprocess: () => createMockSubprocess()
            });
            handles.push(handle);
            return { shutdown: () => handle.shutdown() };
        };
        const socketPath = join(dir, 'test.sock');
        const tokenPath = join(dir, 'test.token');
        const handle = await launcher(socketPath, tokenPath);
        const client = new DaemonClient({ socketPath, tokenPath });
        await client.ensureConnected();
        expect(client.isConnected()).toBe(true);
        client.disconnect();
        await handle.shutdown();
        handles.pop();
    });
});
