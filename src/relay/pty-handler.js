import { resolveDefaultShell, resolveProcessCwd, processHasChildren, getForegroundProcessName, listShellProfiles } from './pty-shell-utils';
// Why: node-pty is a native addon that may not be installed on the remote.
// Dynamic import keeps the require() lazy so loadPty() returns null gracefully
// when the native module is unavailable. The static type import lets vitest
// intercept it in tests.
let ptyModule = null;
async function loadPty() {
    if (ptyModule) {
        return ptyModule;
    }
    try {
        ptyModule = await import('node-pty');
        return ptyModule;
    }
    catch {
        return null;
    }
}
const DEFAULT_GRACE_TIME_MS = 5 * 60 * 1000;
export const REPLAY_BUFFER_MAX = 100 * 1024;
const ALLOWED_SIGNALS = new Set([
    'SIGINT',
    'SIGTERM',
    'SIGHUP',
    'SIGKILL',
    'SIGTSTP',
    'SIGCONT',
    'SIGUSR1',
    'SIGUSR2'
]);
export class PtyHandler {
    ptys = new Map();
    nextId = 1;
    dispatcher;
    graceTimeMs;
    graceTimer = null;
    constructor(dispatcher, graceTimeMs = DEFAULT_GRACE_TIME_MS) {
        this.dispatcher = dispatcher;
        this.graceTimeMs = graceTimeMs;
        this.registerHandlers();
    }
    /** Wire onData/onExit listeners for a managed PTY and store it. */
    wireAndStore(managed) {
        this.ptys.set(managed.id, managed);
        managed.pty.onData((data) => {
            managed.buffered += data;
            if (managed.buffered.length > REPLAY_BUFFER_MAX) {
                managed.buffered = managed.buffered.slice(-REPLAY_BUFFER_MAX);
            }
            this.dispatcher.notify('pty.data', { id: managed.id, data });
        });
        managed.pty.onExit(({ exitCode }) => {
            // Why: If the PTY exits normally (or via SIGTERM), we must clear the
            // SIGKILL fallback timer to avoid sending SIGKILL to a recycled PID.
            if (managed.killTimer) {
                clearTimeout(managed.killTimer);
                managed.killTimer = undefined;
            }
            this.dispatcher.notify('pty.exit', { id: managed.id, code: exitCode });
            this.ptys.delete(managed.id);
        });
    }
    registerHandlers() {
        this.dispatcher.onRequest('pty.spawn', (p) => this.spawn(p));
        this.dispatcher.onRequest('pty.attach', (p) => this.attach(p));
        this.dispatcher.onRequest('pty.shutdown', (p) => this.shutdown(p));
        this.dispatcher.onRequest('pty.sendSignal', (p) => this.sendSignal(p));
        this.dispatcher.onRequest('pty.getCwd', (p) => this.getCwd(p));
        this.dispatcher.onRequest('pty.getInitialCwd', (p) => this.getInitialCwd(p));
        this.dispatcher.onRequest('pty.clearBuffer', (p) => this.clearBuffer(p));
        this.dispatcher.onRequest('pty.hasChildProcesses', (p) => this.hasChildProcesses(p));
        this.dispatcher.onRequest('pty.getForegroundProcess', (p) => this.getForegroundProcess(p));
        this.dispatcher.onRequest('pty.listProcesses', () => this.listProcesses());
        this.dispatcher.onRequest('pty.getDefaultShell', async () => resolveDefaultShell());
        this.dispatcher.onRequest('pty.serialize', (p) => this.serialize(p));
        this.dispatcher.onRequest('pty.revive', (p) => this.revive(p));
        this.dispatcher.onRequest('pty.getProfiles', async () => listShellProfiles());
        this.dispatcher.onNotification('pty.data', (p) => this.writeData(p));
        this.dispatcher.onNotification('pty.resize', (p) => this.resize(p));
        this.dispatcher.onNotification('pty.ackData', (_p) => {
            /* flow control ack -- not yet enforced */
        });
    }
    async spawn(params) {
        if (this.ptys.size >= 50) {
            throw new Error('Maximum number of PTY sessions reached (50)');
        }
        const pty = await loadPty();
        if (!pty) {
            throw new Error('node-pty is not available on this remote host');
        }
        const cols = params.cols || 80;
        const rows = params.rows || 24;
        const cwd = params.cwd || process.env.HOME || '/';
        const env = params.env;
        const shell = resolveDefaultShell();
        const id = `pty-${this.nextId++}`;
        // Why: SSH exec channels give the relay a minimal environment without
        // .zprofile/.bash_profile sourced. Spawning a login shell ensures PATH
        // includes Homebrew, nvm, and user-installed CLIs (claude, codex, gh).
        const term = pty.spawn(shell, ['-l'], {
            name: 'xterm-256color',
            cols,
            rows,
            cwd,
            env: { ...process.env, ...env }
        });
        this.wireAndStore({ id, pty: term, initialCwd: cwd, buffered: '' });
        return { id };
    }
    async attach(params) {
        const id = params.id;
        const managed = this.ptys.get(id);
        if (!managed) {
            throw new Error(`PTY "${id}" not found`);
        }
        // Replay buffered output
        if (managed.buffered) {
            this.dispatcher.notify('pty.replay', { id, data: managed.buffered });
        }
    }
    writeData(params) {
        const id = params.id;
        const data = params.data;
        if (typeof data !== 'string') {
            return;
        }
        const managed = this.ptys.get(id);
        if (managed) {
            managed.pty.write(data);
        }
    }
    resize(params) {
        const id = params.id;
        const cols = Math.max(1, Math.min(500, Math.floor(Number(params.cols) || 80)));
        const rows = Math.max(1, Math.min(500, Math.floor(Number(params.rows) || 24)));
        const managed = this.ptys.get(id);
        if (managed) {
            managed.pty.resize(cols, rows);
        }
    }
    async shutdown(params) {
        const id = params.id;
        const immediate = params.immediate;
        const managed = this.ptys.get(id);
        if (!managed) {
            return;
        }
        if (immediate) {
            managed.pty.kill('SIGKILL');
        }
        else {
            managed.pty.kill('SIGTERM');
            // Why: Some processes ignore SIGTERM (e.g. a hung child, a custom signal
            // handler). Without a SIGKILL fallback the PTY process would leak and the
            // managed entry would never be cleaned up. The 5-second window gives
            // well-behaved processes time to flush and exit gracefully. The timer is
            // cleared in the onExit handler if the process terminates on its own.
            managed.killTimer = setTimeout(() => {
                if (this.ptys.has(id)) {
                    managed.pty.kill('SIGKILL');
                }
            }, 5000);
        }
    }
    async sendSignal(params) {
        const id = params.id;
        const signal = params.signal;
        if (!ALLOWED_SIGNALS.has(signal)) {
            throw new Error(`Signal not allowed: ${signal}`);
        }
        const managed = this.ptys.get(id);
        if (!managed) {
            throw new Error(`PTY "${id}" not found`);
        }
        managed.pty.kill(signal);
    }
    async getCwd(params) {
        const id = params.id;
        const managed = this.ptys.get(id);
        if (!managed) {
            throw new Error(`PTY "${id}" not found`);
        }
        return resolveProcessCwd(managed.pty.pid, managed.initialCwd);
    }
    async getInitialCwd(params) {
        const id = params.id;
        const managed = this.ptys.get(id);
        if (!managed) {
            throw new Error(`PTY "${id}" not found`);
        }
        return managed.initialCwd;
    }
    async clearBuffer(params) {
        const id = params.id;
        const managed = this.ptys.get(id);
        if (managed) {
            managed.pty.clear();
        }
    }
    async hasChildProcesses(params) {
        const id = params.id;
        const managed = this.ptys.get(id);
        if (!managed) {
            return false;
        }
        return await processHasChildren(managed.pty.pid);
    }
    async getForegroundProcess(params) {
        const id = params.id;
        const managed = this.ptys.get(id);
        if (!managed) {
            return null;
        }
        return await getForegroundProcessName(managed.pty.pid);
    }
    async listProcesses() {
        const results = [];
        for (const [id, managed] of this.ptys) {
            const title = (await getForegroundProcessName(managed.pty.pid)) || 'shell';
            results.push({ id, cwd: managed.initialCwd, title });
        }
        return results;
    }
    async serialize(params) {
        const ids = params.ids;
        const entries = [];
        for (const id of ids) {
            const managed = this.ptys.get(id);
            if (!managed) {
                continue;
            }
            const { pid, cols, rows } = managed.pty;
            entries.push({ id, pid, cols, rows, cwd: managed.initialCwd });
        }
        return JSON.stringify(entries);
    }
    async revive(params) {
        const state = params.state;
        const entries = JSON.parse(state);
        for (const entry of entries) {
            if (this.ptys.has(entry.id)) {
                continue;
            }
            // Only re-attach if the original process is still alive
            try {
                process.kill(entry.pid, 0);
            }
            catch {
                continue;
            }
            const ptyMod = await loadPty();
            if (!ptyMod) {
                continue;
            }
            const term = ptyMod.spawn(resolveDefaultShell(), ['-l'], {
                name: 'xterm-256color',
                cols: entry.cols,
                rows: entry.rows,
                cwd: entry.cwd,
                env: process.env
            });
            this.wireAndStore({ id: entry.id, pty: term, initialCwd: entry.cwd, buffered: '' });
            // Why: nextId starts at 1 and is only incremented by spawn(). Revived
            // PTYs carry their original IDs (e.g. "pty-3"), so without this bump the
            // next spawn() would generate an ID that collides with an already-active
            // revived PTY.
            const match = entry.id.match(/^pty-(\d+)$/);
            if (match) {
                const revivedNum = parseInt(match[1], 10);
                if (revivedNum >= this.nextId) {
                    this.nextId = revivedNum + 1;
                }
            }
        }
    }
    startGraceTimer(onExpire) {
        this.cancelGraceTimer();
        if (this.ptys.size === 0) {
            onExpire();
            return;
        }
        this.graceTimer = setTimeout(() => {
            onExpire();
        }, this.graceTimeMs);
    }
    cancelGraceTimer() {
        if (this.graceTimer) {
            clearTimeout(this.graceTimer);
            this.graceTimer = null;
        }
    }
    dispose() {
        this.cancelGraceTimer();
        for (const [, managed] of this.ptys) {
            if (managed.killTimer) {
                clearTimeout(managed.killTimer);
            }
            managed.pty.kill('SIGTERM');
        }
        this.ptys.clear();
    }
    get activePtyCount() {
        return this.ptys.size;
    }
}
