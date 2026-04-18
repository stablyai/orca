import { describe, expect, it, vi } from 'vitest';
import { resolveWithSshG } from './ssh-config-parser';
vi.mock('os', () => ({
    homedir: () => '/home/testuser'
}));
vi.mock('child_process', () => ({
    execFile: vi.fn()
}));
describe('resolveWithSshG', () => {
    it('returns parsed config on success', async () => {
        const { execFile } = await import('child_process');
        const mockExecFile = vi.mocked(execFile);
        mockExecFile.mockImplementation((_cmd, _args, _opts, cb) => {
            const callback = cb;
            callback(null, 'hostname 10.0.0.1\nuser admin\nport 22');
            return undefined;
        });
        const result = await resolveWithSshG('myhost');
        expect(result).toBeDefined();
        expect(result.hostname).toBe('10.0.0.1');
        expect(result.user).toBe('admin');
    });
    it('calls ssh -G with the given host', async () => {
        const { execFile } = await import('child_process');
        const mockExecFile = vi.mocked(execFile);
        mockExecFile.mockImplementation((_cmd, _args, _opts, cb) => {
            const callback = cb;
            callback(null, 'hostname example.com\nport 22');
            return undefined;
        });
        await resolveWithSshG('testserver');
        expect(mockExecFile).toHaveBeenCalledWith('ssh', ['-G', '--', 'testserver'], expect.objectContaining({ timeout: 5000 }), expect.any(Function));
    });
    it('returns null when ssh -G fails', async () => {
        const { execFile } = await import('child_process');
        const mockExecFile = vi.mocked(execFile);
        mockExecFile.mockImplementation((_cmd, _args, _opts, cb) => {
            const callback = cb;
            callback(new Error('ssh not found'), '');
            return undefined;
        });
        const result = await resolveWithSshG('myhost');
        expect(result).toBeNull();
    });
});
