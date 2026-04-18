import { describe, expect, it, vi, beforeEach } from 'vitest';
const { existsSyncMock, spawnMock } = vi.hoisted(() => ({
    existsSyncMock: vi.fn(),
    spawnMock: vi.fn()
}));
vi.mock('fs', () => ({
    existsSync: existsSyncMock
}));
vi.mock('child_process', () => ({
    spawn: spawnMock
}));
import { findSystemSsh, spawnSystemSsh } from './ssh-system-fallback';
function createTarget(overrides) {
    return {
        id: 'target-1',
        label: 'Test Server',
        host: 'example.com',
        port: 22,
        username: 'deploy',
        ...overrides
    };
}
describe('findSystemSsh', () => {
    beforeEach(() => {
        existsSyncMock.mockReset();
    });
    it('returns the first existing ssh path', () => {
        existsSyncMock.mockImplementation((p) => p === '/usr/bin/ssh');
        expect(findSystemSsh()).toBe('/usr/bin/ssh');
    });
    it('returns null when no ssh binary is found', () => {
        existsSyncMock.mockReturnValue(false);
        expect(findSystemSsh()).toBeNull();
    });
});
describe('spawnSystemSsh', () => {
    let mockProc;
    beforeEach(() => {
        existsSyncMock.mockReset();
        spawnMock.mockReset();
        mockProc = {
            stdin: { write: vi.fn(), end: vi.fn() },
            stdout: { on: vi.fn() },
            stderr: { on: vi.fn() },
            pid: 12345,
            on: vi.fn(),
            kill: vi.fn()
        };
        spawnMock.mockReturnValue(mockProc);
        existsSyncMock.mockImplementation((p) => p === '/usr/bin/ssh');
    });
    it('spawns ssh with correct arguments for basic target', () => {
        spawnSystemSsh(createTarget());
        expect(spawnMock).toHaveBeenCalledWith('/usr/bin/ssh', expect.arrayContaining(['-T', 'deploy@example.com']), expect.objectContaining({ stdio: ['pipe', 'pipe', 'pipe'] }));
    });
    it('includes port flag when not 22', () => {
        spawnSystemSsh(createTarget({ port: 2222 }));
        const args = spawnMock.mock.calls[0][1];
        expect(args).toContain('-p');
        expect(args).toContain('2222');
    });
    it('does not include port flag when port is 22', () => {
        spawnSystemSsh(createTarget({ port: 22 }));
        const args = spawnMock.mock.calls[0][1];
        expect(args).not.toContain('-p');
    });
    it('includes identity file flag', () => {
        spawnSystemSsh(createTarget({ identityFile: '/home/user/.ssh/id_ed25519' }));
        const args = spawnMock.mock.calls[0][1];
        expect(args).toContain('-i');
        expect(args).toContain('/home/user/.ssh/id_ed25519');
    });
    it('includes jump host flag', () => {
        spawnSystemSsh(createTarget({ jumpHost: 'bastion.example.com' }));
        const args = spawnMock.mock.calls[0][1];
        expect(args).toContain('-J');
        expect(args).toContain('bastion.example.com');
    });
    it('includes proxy command flag', () => {
        spawnSystemSsh(createTarget({ proxyCommand: 'ssh -W %h:%p bastion' }));
        const args = spawnMock.mock.calls[0][1];
        expect(args).toContain('-o');
        expect(args).toContain('ProxyCommand=ssh -W %h:%p bastion');
    });
    it('throws when no system ssh is found', () => {
        existsSyncMock.mockReturnValue(false);
        expect(() => spawnSystemSsh(createTarget())).toThrow('No system ssh binary found');
    });
    it('returns a process wrapper with kill and onExit', () => {
        const result = spawnSystemSsh(createTarget());
        expect(result.pid).toBe(12345);
        expect(typeof result.kill).toBe('function');
        expect(typeof result.onExit).toBe('function');
    });
});
