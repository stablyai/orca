import { readFileSync, existsSync } from 'fs';
import { execFile } from 'child_process';
import { join } from 'path';
import { homedir } from 'os';
/**
 * Parse an OpenSSH config file into structured host entries.
 * Handles Host blocks with single or multiple patterns.
 * Ignores wildcard-only patterns (e.g. "Host *").
 */
export function parseSshConfig(content) {
    const hosts = [];
    let current = null;
    for (const rawLine of content.split('\n')) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) {
            continue;
        }
        const match = line.match(/^(\S+)\s+(.+)$/);
        if (!match) {
            continue;
        }
        const [, keyword, rawValue] = match;
        const key = keyword.toLowerCase();
        const value = rawValue.trim();
        if (key === 'host') {
            if (current) {
                hosts.push(current);
            }
            // Skip wildcard-only entries (e.g. "Host *" or "Host *.*")
            const patterns = value.split(/\s+/);
            const hasConcretePattern = patterns.some((p) => !p.includes('*') && !p.includes('?'));
            if (!hasConcretePattern) {
                current = null;
                continue;
            }
            current = { host: patterns[0] };
            continue;
        }
        if (key === 'match') {
            // Match blocks are complex conditionals — push current and skip
            if (current) {
                hosts.push(current);
            }
            current = null;
            continue;
        }
        if (!current) {
            continue;
        }
        switch (key) {
            case 'hostname':
                current.hostname = value;
                break;
            case 'port':
                current.port = parseInt(value, 10) || 22;
                break;
            case 'user':
                current.user = value;
                break;
            case 'identityfile':
                current.identityFile = resolveHomePath(value);
                break;
            case 'proxycommand':
                current.proxyCommand = value;
                break;
            case 'proxyjump':
                current.proxyJump = value;
                break;
        }
    }
    if (current) {
        hosts.push(current);
    }
    return hosts;
}
function resolveHomePath(filepath) {
    if (filepath.startsWith('~/') || filepath === '~') {
        return join(homedir(), filepath.slice(1));
    }
    return filepath;
}
/** Read and parse the user's ~/.ssh/config file. Returns empty array if not found. */
export function loadUserSshConfig() {
    const configPath = join(homedir(), '.ssh', 'config');
    if (!existsSync(configPath)) {
        return [];
    }
    try {
        const content = readFileSync(configPath, 'utf-8');
        return parseSshConfig(content);
    }
    catch {
        console.warn(`[ssh] Failed to read SSH config at ${configPath}`);
        return [];
    }
}
/** Convert parsed SSH config hosts into SshTarget objects for import. */
export function sshConfigHostsToTargets(hosts, existingTargetHosts) {
    const targets = [];
    for (const entry of hosts) {
        const effectiveHost = entry.hostname || entry.host;
        const label = entry.host;
        // Skip if already imported (match on label, which is the Host alias)
        if (existingTargetHosts.has(label)) {
            continue;
        }
        targets.push({
            id: `ssh-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            label,
            configHost: entry.host,
            host: effectiveHost,
            port: entry.port ?? 22,
            username: entry.user ?? '',
            identityFile: entry.identityFile,
            proxyCommand: entry.proxyCommand,
            jumpHost: entry.proxyJump
        });
    }
    return targets;
}
const SSH_G_TIMEOUT_MS = 5000;
// Why: `ssh -G <host>` asks OpenSSH to resolve the full effective config
// for a host, including Include directives, Match blocks, wildcard
// inheritance, and ProxyCommand expansion. This gives us correct config
// resolution without reimplementing OpenSSH's complex matching logic.
export function resolveWithSshG(host) {
    return new Promise((resolve) => {
        // Why: '--' prevents a host label starting with '-' from being interpreted
        // as an SSH flag (classic argument injection vector).
        execFile('ssh', ['-G', '--', host], { timeout: SSH_G_TIMEOUT_MS }, (err, stdout) => {
            if (err) {
                resolve(null);
                return;
            }
            resolve(parseSshGOutput(stdout));
        });
    });
}
export function parseSshGOutput(stdout) {
    const map = new Map();
    const identityFiles = [];
    for (const line of stdout.split('\n')) {
        const spaceIdx = line.indexOf(' ');
        if (spaceIdx === -1) {
            continue;
        }
        const key = line.substring(0, spaceIdx).toLowerCase();
        const value = line.substring(spaceIdx + 1).trim();
        if (key === 'identityfile') {
            identityFiles.push(resolveHomePath(value));
        }
        else {
            map.set(key, value);
        }
    }
    // Why: `ssh -G` outputs `proxycommand none` / `proxyjump none` when no
    // proxy is configured. Treating "none" as real would spawn bad commands.
    const rawProxy = map.get('proxycommand');
    const proxyCommand = rawProxy && rawProxy !== 'none' ? rawProxy : undefined;
    const rawJump = map.get('proxyjump');
    const proxyJump = rawJump && rawJump !== 'none' ? rawJump : undefined;
    return {
        hostname: map.get('hostname') ?? '',
        user: map.get('user') || undefined,
        port: parseInt(map.get('port') ?? '22', 10),
        identityFile: identityFiles,
        forwardAgent: map.get('forwardagent') === 'yes',
        proxyCommand,
        proxyJump
    };
}
