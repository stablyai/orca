import { afterEach, describe, expect, it, vi, beforeEach } from 'vitest';
vi.mock('os', () => ({
    homedir: () => '/home/testuser'
}));
const mockExistsSync = vi.fn().mockReturnValue(false);
const mockReadFileSync = vi.fn();
vi.mock('fs', () => ({
    existsSync: (...args) => mockExistsSync(...args),
    readFileSync: (...args) => mockReadFileSync(...args)
}));
import { isTransientError, isAuthError, sleep, shellEscape, findDefaultKeyFile, buildConnectConfig, resolveEffectiveProxy, CONNECT_TIMEOUT_MS, INITIAL_RETRY_ATTEMPTS, INITIAL_RETRY_DELAY_MS, RECONNECT_BACKOFF_MS } from './ssh-connection-utils';
// ── Constants ────────────────────────────────────────────────────────
describe('SSH connection constants', () => {
    it('CONNECT_TIMEOUT_MS is 30 seconds (matches VS Code)', () => {
        expect(CONNECT_TIMEOUT_MS).toBe(30_000);
    });
    it('INITIAL_RETRY_ATTEMPTS is 5', () => {
        expect(INITIAL_RETRY_ATTEMPTS).toBe(5);
    });
    it('INITIAL_RETRY_DELAY_MS is 2 seconds', () => {
        expect(INITIAL_RETRY_DELAY_MS).toBe(2000);
    });
    it('RECONNECT_BACKOFF_MS has 9 entries', () => {
        expect(RECONNECT_BACKOFF_MS).toHaveLength(9);
    });
});
// ── isTransientError ─────────────────────────────────────────────────
describe('isTransientError', () => {
    it('returns true for ETIMEDOUT code', () => {
        const err = new Error('timed out');
        err.code = 'ETIMEDOUT';
        expect(isTransientError(err)).toBe(true);
    });
    it('returns true for ECONNREFUSED code', () => {
        const err = new Error('refused');
        err.code = 'ECONNREFUSED';
        expect(isTransientError(err)).toBe(true);
    });
    it('returns true for ECONNRESET code', () => {
        const err = new Error('reset');
        err.code = 'ECONNRESET';
        expect(isTransientError(err)).toBe(true);
    });
    it('returns true for EHOSTUNREACH code', () => {
        const err = new Error('host unreachable');
        err.code = 'EHOSTUNREACH';
        expect(isTransientError(err)).toBe(true);
    });
    it('returns true for ENETUNREACH code', () => {
        const err = new Error('net unreachable');
        err.code = 'ENETUNREACH';
        expect(isTransientError(err)).toBe(true);
    });
    it('returns true for EAI_AGAIN code', () => {
        const err = new Error('dns');
        err.code = 'EAI_AGAIN';
        expect(isTransientError(err)).toBe(true);
    });
    it('returns true for ETIMEDOUT in message (no code)', () => {
        expect(isTransientError(new Error('connect ETIMEDOUT 1.2.3.4:22'))).toBe(true);
    });
    it('returns true for ECONNREFUSED in message', () => {
        expect(isTransientError(new Error('connect ECONNREFUSED 1.2.3.4:22'))).toBe(true);
    });
    it('returns true for ECONNRESET in message', () => {
        expect(isTransientError(new Error('read ECONNRESET'))).toBe(true);
    });
    it('returns false for auth errors', () => {
        expect(isTransientError(new Error('All configured authentication methods failed'))).toBe(false);
    });
    it('returns false for generic errors', () => {
        expect(isTransientError(new Error('something went wrong'))).toBe(false);
    });
});
// ── isAuthError ──────────────────────────────────────────────────────
describe('isAuthError', () => {
    it('returns true for "All configured authentication methods failed"', () => {
        expect(isAuthError(new Error('All configured authentication methods failed'))).toBe(true);
    });
    it('returns true for "Authentication failed"', () => {
        expect(isAuthError(new Error('Authentication failed'))).toBe(true);
    });
    it('returns true for client-authentication level', () => {
        const err = new Error('auth');
        err.level = 'client-authentication';
        expect(isAuthError(err)).toBe(true);
    });
    it('returns false for transient errors', () => {
        expect(isAuthError(new Error('connect ETIMEDOUT'))).toBe(false);
    });
});
// ── sleep ────────────────────────────────────────────────────────────
describe('sleep', () => {
    it('resolves after the given delay', async () => {
        const start = Date.now();
        await sleep(50);
        expect(Date.now() - start).toBeGreaterThanOrEqual(40);
    });
});
// ── shellEscape ──────────────────────────────────────────────────────
describe('shellEscape', () => {
    it('wraps string in single quotes', () => {
        expect(shellEscape('hello')).toBe("'hello'");
    });
    it('escapes embedded single quotes', () => {
        expect(shellEscape("it's")).toBe("'it'\\''s'");
    });
    it('handles empty string', () => {
        expect(shellEscape('')).toBe("''");
    });
    it('handles special characters', () => {
        expect(shellEscape('foo bar; rm -rf /')).toBe("'foo bar; rm -rf /'");
    });
});
// ── findDefaultKeyFile ───────────────────────────────────────────────
describe('findDefaultKeyFile', () => {
    beforeEach(() => {
        mockExistsSync.mockReturnValue(false);
        mockReadFileSync.mockReset();
    });
    it('returns undefined when no default keys exist', () => {
        expect(findDefaultKeyFile()).toBeUndefined();
    });
    it('returns the first existing key file', () => {
        mockExistsSync.mockImplementation((path) => {
            return path === '/home/testuser/.ssh/id_ed25519';
        });
        mockReadFileSync.mockReturnValue(Buffer.from('key-contents'));
        const result = findDefaultKeyFile();
        expect(result).toBeDefined();
        expect(result.path).toBe('~/.ssh/id_ed25519');
        expect(result.contents).toEqual(Buffer.from('key-contents'));
    });
    it('probes keys in VS Code order: ed25519, rsa, ecdsa, dsa, xmss', () => {
        const checkedPaths = [];
        mockExistsSync.mockImplementation((path) => {
            checkedPaths.push(String(path));
            return false;
        });
        findDefaultKeyFile();
        expect(checkedPaths).toEqual([
            '/home/testuser/.ssh/id_ed25519',
            '/home/testuser/.ssh/id_rsa',
            '/home/testuser/.ssh/id_ecdsa',
            '/home/testuser/.ssh/id_dsa',
            '/home/testuser/.ssh/id_xmss'
        ]);
    });
    it('skips unreadable key files and tries next', () => {
        mockExistsSync.mockImplementation((path) => {
            return path === '/home/testuser/.ssh/id_ed25519' || path === '/home/testuser/.ssh/id_rsa';
        });
        mockReadFileSync.mockImplementation((path) => {
            if (String(path) === '/home/testuser/.ssh/id_ed25519') {
                throw new Error('permission denied');
            }
            return Buffer.from('rsa-key');
        });
        const result = findDefaultKeyFile();
        expect(result).toBeDefined();
        expect(result.path).toBe('~/.ssh/id_rsa');
    });
});
// ── buildConnectConfig ──────────────────────────────────────────────
function makeTarget(overrides) {
    return {
        id: 'test-1',
        label: 'myhost',
        host: 'example.com',
        port: 22,
        username: 'deploy',
        ...overrides
    };
}
function makeResolved(overrides) {
    return {
        hostname: '10.0.0.1',
        port: 22,
        identityFile: [],
        forwardAgent: false,
        ...overrides
    };
}
describe('buildConnectConfig', () => {
    const originalEnv = process.env.SSH_AUTH_SOCK;
    beforeEach(() => {
        mockExistsSync.mockReturnValue(false);
        mockReadFileSync.mockReset();
        process.env.SSH_AUTH_SOCK = '/tmp/agent.sock';
    });
    afterEach(() => {
        if (originalEnv !== undefined) {
            process.env.SSH_AUTH_SOCK = originalEnv;
        }
        else {
            delete process.env.SSH_AUTH_SOCK;
        }
    });
    it('uses target host/port/username', () => {
        const config = buildConnectConfig(makeTarget(), null);
        expect(config.host).toBe('example.com');
        expect(config.port).toBe(22);
        expect(config.username).toBe('deploy');
    });
    it('falls back to resolved config when target fields are empty', () => {
        const config = buildConnectConfig(makeTarget({ host: '', port: 0, username: '' }), makeResolved({ hostname: '10.0.0.1', port: 2222, user: 'admin' }));
        expect(config.host).toBe('10.0.0.1');
        expect(config.port).toBe(2222);
        expect(config.username).toBe('admin');
    });
    it('sets readyTimeout to CONNECT_TIMEOUT_MS', () => {
        const config = buildConnectConfig(makeTarget(), null);
        expect(config.readyTimeout).toBe(30_000);
    });
    it('sets keepaliveInterval to 15s', () => {
        const config = buildConnectConfig(makeTarget(), null);
        expect(config.keepaliveInterval).toBe(15_000);
    });
    it('uses agent auth when no explicit key and SSH_AUTH_SOCK is set', () => {
        const config = buildConnectConfig(makeTarget(), null);
        expect(config.agent).toBe('/tmp/agent.sock');
    });
    it('uses keyFile auth when target.identityFile is set', () => {
        mockReadFileSync.mockReturnValue(Buffer.from('key'));
        const config = buildConnectConfig(makeTarget({ identityFile: '/home/user/.ssh/custom' }), null);
        expect(config.privateKey).toEqual(Buffer.from('key'));
        expect(config.agent).toBe('/tmp/agent.sock');
    });
    it('uses keyFile auth when resolved identityFile is non-default', () => {
        mockReadFileSync.mockReturnValue(Buffer.from('custom-key'));
        const config = buildConnectConfig(makeTarget(), makeResolved({ identityFile: ['/home/user/.ssh/work_key'] }));
        expect(config.privateKey).toEqual(Buffer.from('custom-key'));
        expect(config.agent).toBe('/tmp/agent.sock');
    });
    it('uses agent auth when resolved identityFile is a default path (expanded)', () => {
        const config = buildConnectConfig(makeTarget(), makeResolved({ identityFile: ['/home/testuser/.ssh/id_ed25519'] }));
        expect(config.agent).toBe('/tmp/agent.sock');
    });
    it('provides fallback key in agent auth mode', () => {
        mockExistsSync.mockImplementation((p) => String(p) === '/home/testuser/.ssh/id_ed25519');
        mockReadFileSync.mockReturnValue(Buffer.from('fallback'));
        const config = buildConnectConfig(makeTarget(), null);
        expect(config.agent).toBe('/tmp/agent.sock');
        expect(config.privateKey).toEqual(Buffer.from('fallback'));
    });
});
// ── resolveEffectiveProxy ───────────────────────────────────────────
describe('resolveEffectiveProxy', () => {
    it('returns target.proxyCommand first', () => {
        const target = { ...makeTarget(), proxyCommand: 'cloudflared access ssh --hostname %h' };
        const resolved = makeResolved({ proxyCommand: 'other' });
        expect(resolveEffectiveProxy(target, resolved)).toEqual({
            kind: 'proxy-command',
            command: 'cloudflared access ssh --hostname %h'
        });
    });
    it('falls back to resolved proxyCommand', () => {
        expect(resolveEffectiveProxy(makeTarget(), makeResolved({ proxyCommand: 'ssh -W %h:%p gw' }))).toEqual({
            kind: 'proxy-command',
            command: 'ssh -W %h:%p gw'
        });
    });
    it('returns structured jump-host config for target.jumpHost', () => {
        const target = { ...makeTarget(), jumpHost: 'bastion.example.com' };
        expect(resolveEffectiveProxy(target, null)).toEqual({
            kind: 'jump-host',
            jumpHost: 'bastion.example.com'
        });
    });
    it('returns structured jump-host config for resolved proxyJump', () => {
        expect(resolveEffectiveProxy(makeTarget(), makeResolved({ proxyJump: 'jump.host' }))).toEqual({
            kind: 'jump-host',
            jumpHost: 'jump.host'
        });
    });
    it('returns undefined when no proxy is configured', () => {
        expect(resolveEffectiveProxy(makeTarget(), null)).toBeUndefined();
    });
});
