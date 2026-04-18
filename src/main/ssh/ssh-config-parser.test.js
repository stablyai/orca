import { describe, expect, it, vi } from 'vitest';
import { parseSshConfig, sshConfigHostsToTargets, parseSshGOutput } from './ssh-config-parser';
vi.mock('os', () => ({
    homedir: () => '/home/testuser'
}));
describe('parseSshConfig', () => {
    it('parses a basic host block', () => {
        const config = `
Host myserver
  HostName 192.168.1.100
  User deploy
  Port 2222
`;
        const hosts = parseSshConfig(config);
        expect(hosts).toHaveLength(1);
        expect(hosts[0]).toEqual({
            host: 'myserver',
            hostname: '192.168.1.100',
            user: 'deploy',
            port: 2222
        });
    });
    it('parses multiple host blocks', () => {
        const config = `
Host staging
  HostName staging.example.com
  User admin

Host production
  HostName prod.example.com
  User deploy
  Port 2222
`;
        const hosts = parseSshConfig(config);
        expect(hosts).toHaveLength(2);
        expect(hosts[0].host).toBe('staging');
        expect(hosts[1].host).toBe('production');
        expect(hosts[1].port).toBe(2222);
    });
    it('skips wildcard-only Host entries', () => {
        const config = `
Host *
  ServerAliveInterval 60

Host myserver
  HostName 10.0.0.1
`;
        const hosts = parseSshConfig(config);
        expect(hosts).toHaveLength(1);
        expect(hosts[0].host).toBe('myserver');
    });
    it('skips Host entries with only pattern characters', () => {
        const config = `
Host *.example.com
  User admin

Host dev
  HostName dev.example.com
`;
        const hosts = parseSshConfig(config);
        expect(hosts).toHaveLength(1);
        expect(hosts[0].host).toBe('dev');
    });
    it('parses IdentityFile with ~ expansion', () => {
        const config = `
Host myserver
  HostName example.com
  IdentityFile ~/.ssh/id_ed25519
`;
        const hosts = parseSshConfig(config);
        expect(hosts[0].identityFile).toBe('/home/testuser/.ssh/id_ed25519');
    });
    it('parses ProxyCommand and ProxyJump', () => {
        const config = `
Host internal
  HostName 10.0.0.5
  ProxyCommand ssh -W %h:%p bastion
  ProxyJump bastion.example.com
`;
        const hosts = parseSshConfig(config);
        expect(hosts[0].proxyCommand).toBe('ssh -W %h:%p bastion');
        expect(hosts[0].proxyJump).toBe('bastion.example.com');
    });
    it('ignores comments and blank lines', () => {
        const config = `
# This is a comment
Host myserver
  # Another comment
  HostName example.com

  User admin
`;
        const hosts = parseSshConfig(config);
        expect(hosts).toHaveLength(1);
        expect(hosts[0].user).toBe('admin');
    });
    it('handles case-insensitive keywords', () => {
        const config = `
Host myserver
  hostname EXAMPLE.COM
  user Admin
  port 3022
`;
        const hosts = parseSshConfig(config);
        expect(hosts[0].hostname).toBe('EXAMPLE.COM');
        expect(hosts[0].user).toBe('Admin');
        expect(hosts[0].port).toBe(3022);
    });
    it('stops current block on Match directive', () => {
        const config = `
Host myserver
  HostName example.com

Match host *.internal
  User internal-admin

Host other
  HostName other.com
`;
        const hosts = parseSshConfig(config);
        expect(hosts).toHaveLength(2);
        expect(hosts[0].host).toBe('myserver');
        expect(hosts[1].host).toBe('other');
    });
    it('returns empty array for empty input', () => {
        expect(parseSshConfig('')).toEqual([]);
    });
    it('uses first pattern from multi-pattern Host line', () => {
        const config = `
Host staging stage
  HostName staging.example.com
`;
        const hosts = parseSshConfig(config);
        expect(hosts).toHaveLength(1);
        expect(hosts[0].host).toBe('staging');
    });
    it('defaults port to 22 for invalid port values', () => {
        const config = `
Host myserver
  Port notanumber
`;
        const hosts = parseSshConfig(config);
        expect(hosts[0].port).toBe(22);
    });
});
describe('sshConfigHostsToTargets', () => {
    it('converts hosts to SshTarget objects', () => {
        const hosts = [{ host: 'myserver', hostname: '10.0.0.1', port: 22, user: 'deploy' }];
        const targets = sshConfigHostsToTargets(hosts, new Set());
        expect(targets).toHaveLength(1);
        expect(targets[0]).toMatchObject({
            label: 'myserver',
            host: '10.0.0.1',
            port: 22,
            username: 'deploy'
        });
        expect(targets[0].id).toMatch(/^ssh-/);
    });
    it('uses host alias as hostname when HostName is missing', () => {
        const hosts = [{ host: 'myserver' }];
        const targets = sshConfigHostsToTargets(hosts, new Set());
        expect(targets[0].host).toBe('myserver');
    });
    it('skips hosts that are already imported', () => {
        const hosts = [
            { host: 'existing', hostname: '10.0.0.1' },
            { host: 'new-host', hostname: '10.0.0.2' }
        ];
        const targets = sshConfigHostsToTargets(hosts, new Set(['existing']));
        expect(targets).toHaveLength(1);
        expect(targets[0].label).toBe('new-host');
    });
    it('defaults username to empty string when not specified', () => {
        const hosts = [{ host: 'nouser', hostname: '10.0.0.1' }];
        const targets = sshConfigHostsToTargets(hosts, new Set());
        expect(targets[0].username).toBe('');
    });
    it('carries through identityFile, proxyCommand, and jumpHost', () => {
        const hosts = [
            {
                host: 'internal',
                hostname: '10.0.0.5',
                identityFile: '/home/user/.ssh/id_rsa',
                proxyCommand: 'ssh -W %h:%p bastion',
                proxyJump: 'bastion.example.com'
            }
        ];
        const targets = sshConfigHostsToTargets(hosts, new Set());
        expect(targets[0].identityFile).toBe('/home/user/.ssh/id_rsa');
        expect(targets[0].proxyCommand).toBe('ssh -W %h:%p bastion');
        expect(targets[0].jumpHost).toBe('bastion.example.com');
    });
});
// ── parseSshGOutput ──────────────────────────────────────────────────
describe('parseSshGOutput', () => {
    it('parses hostname, user, port from ssh -G output', () => {
        const output = [
            'hostname 192.168.1.100',
            'user deploy',
            'port 2222',
            'identityfile /home/testuser/.ssh/id_ed25519',
            'forwardagent no'
        ].join('\n');
        const result = parseSshGOutput(output);
        expect(result.hostname).toBe('192.168.1.100');
        expect(result.user).toBe('deploy');
        expect(result.port).toBe(2222);
        expect(result.identityFile).toEqual(['/home/testuser/.ssh/id_ed25519']);
        expect(result.forwardAgent).toBe(false);
    });
    it('collects multiple identity files', () => {
        const output = [
            'hostname example.com',
            'identityfile ~/.ssh/id_ed25519',
            'identityfile ~/.ssh/id_rsa',
            'port 22'
        ].join('\n');
        const result = parseSshGOutput(output);
        expect(result.identityFile).toEqual([
            '/home/testuser/.ssh/id_ed25519',
            '/home/testuser/.ssh/id_rsa'
        ]);
    });
    it('parses forwardagent yes', () => {
        const output = 'hostname example.com\nforwardagent yes\nport 22';
        const result = parseSshGOutput(output);
        expect(result.forwardAgent).toBe(true);
    });
    it('defaults port to 22 when missing', () => {
        const output = 'hostname example.com';
        const result = parseSshGOutput(output);
        expect(result.port).toBe(22);
    });
    it('returns empty hostname when missing', () => {
        const output = 'user admin\nport 22';
        const result = parseSshGOutput(output);
        expect(result.hostname).toBe('');
    });
    it('returns undefined user when missing', () => {
        const output = 'hostname example.com\nport 22';
        const result = parseSshGOutput(output);
        expect(result.user).toBeUndefined();
    });
    it('handles empty output', () => {
        const result = parseSshGOutput('');
        expect(result.hostname).toBe('');
        expect(result.port).toBe(22);
        expect(result.identityFile).toEqual([]);
    });
    it('skips lines without spaces', () => {
        const output = 'hostname example.com\nbadline\nport 22';
        const result = parseSshGOutput(output);
        expect(result.hostname).toBe('example.com');
        expect(result.port).toBe(22);
    });
    it('parses proxycommand and filters "none"', () => {
        const output = 'hostname example.com\nproxycommand ssh -W %h:%p bastion\nport 22';
        const result = parseSshGOutput(output);
        expect(result.proxyCommand).toBe('ssh -W %h:%p bastion');
        const noneOutput = 'hostname example.com\nproxycommand none\nport 22';
        const noneResult = parseSshGOutput(noneOutput);
        expect(noneResult.proxyCommand).toBeUndefined();
    });
    it('parses proxyjump and filters "none"', () => {
        const output = 'hostname example.com\nproxyjump bastion.example.com\nport 22';
        const result = parseSshGOutput(output);
        expect(result.proxyJump).toBe('bastion.example.com');
        const noneOutput = 'hostname example.com\nproxyjump none\nport 22';
        const noneResult = parseSshGOutput(noneOutput);
        expect(noneResult.proxyJump).toBeUndefined();
    });
    it('handles ~ expansion in identity file paths', () => {
        const output = 'hostname example.com\nidentityfile ~/custom_key\nport 22';
        const result = parseSshGOutput(output);
        expect(result.identityFile).toEqual(['/home/testuser/custom_key']);
    });
});
// Why: resolveWithSshG tests are in ssh-config-resolver.test.ts (max-lines).
