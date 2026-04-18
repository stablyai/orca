import { HeadlessEmulator } from './headless-emulator';
const SHELL_READY_TIMEOUT_MS = 15_000;
const KILL_TIMEOUT_MS = 5_000;
const SHELL_READY_MARKER = '\x1b]777;orca-shell-ready\x07';
export class Session {
    sessionId;
    _state = 'running';
    _shellState;
    _exitCode = null;
    _isTerminating = false;
    _disposed = false;
    emulator;
    subprocess;
    attachedClients = [];
    preReadyStdinQueue = [];
    markerBuffer = '';
    shellReadyTimer = null;
    killTimer = null;
    constructor(opts) {
        this.sessionId = opts.sessionId;
        this.subprocess = opts.subprocess;
        this.emulator = new HeadlessEmulator({
            cols: opts.cols,
            rows: opts.rows,
            scrollback: opts.scrollback,
            onData: (data) => {
                // Forward xterm.js query responses (DA1 etc.) to subprocess
                opts.subprocess.write(data);
            }
        });
        if (opts.shellReadySupported) {
            this._shellState = 'pending';
            this.shellReadyTimer = setTimeout(() => {
                this.onShellReadyTimeout();
            }, SHELL_READY_TIMEOUT_MS);
        }
        else {
            this._shellState = 'unsupported';
        }
        this.subprocess.onData((data) => this.handleSubprocessData(data));
        this.subprocess.onExit((code) => this.handleSubprocessExit(code));
    }
    get state() {
        return this._state;
    }
    get shellState() {
        return this._shellState;
    }
    get exitCode() {
        return this._exitCode;
    }
    get isAlive() {
        return this._state !== 'exited';
    }
    get isTerminating() {
        return this._isTerminating;
    }
    get pid() {
        return this.subprocess.pid;
    }
    write(data) {
        if (this._state === 'exited' || this._disposed) {
            return;
        }
        if (this._shellState === 'pending') {
            this.preReadyStdinQueue.push(data);
            return;
        }
        this.subprocess.write(data);
    }
    resize(cols, rows) {
        if (this._state === 'exited' || this._disposed) {
            return;
        }
        this.emulator.resize(cols, rows);
        this.subprocess.resize(cols, rows);
    }
    kill() {
        if (this._state === 'exited' || this._isTerminating) {
            return;
        }
        this._isTerminating = true;
        this.subprocess.kill();
        this.killTimer = setTimeout(() => {
            if (this._state !== 'exited') {
                this.forceDispose();
            }
        }, KILL_TIMEOUT_MS);
    }
    signal(sig) {
        if (this._state === 'exited') {
            return;
        }
        this.subprocess.signal(sig);
    }
    attachClient(client) {
        const token = Symbol('attach');
        this.attachedClients.push({ token, ...client });
        return token;
    }
    detachClient(token) {
        const idx = this.attachedClients.findIndex((c) => c.token === token);
        if (idx !== -1) {
            this.attachedClients.splice(idx, 1);
        }
    }
    detachAllClients() {
        this.attachedClients.length = 0;
    }
    getSnapshot() {
        if (this._disposed) {
            return null;
        }
        return this.emulator.getSnapshot();
    }
    getCwd() {
        return this.emulator.getCwd();
    }
    clearScrollback() {
        if (this._disposed) {
            return;
        }
        this.emulator.clearScrollback();
    }
    dispose() {
        if (this._disposed) {
            return;
        }
        this._disposed = true;
        this._state = 'exited';
        if (this.shellReadyTimer) {
            clearTimeout(this.shellReadyTimer);
            this.shellReadyTimer = null;
        }
        if (this.killTimer) {
            clearTimeout(this.killTimer);
            this.killTimer = null;
        }
        this.attachedClients = [];
        this.preReadyStdinQueue = [];
        this.emulator.dispose();
    }
    handleSubprocessData(data) {
        if (this._disposed) {
            return;
        }
        // Feed data to headless emulator for state tracking
        this.emulator.write(data);
        if (this._shellState === 'pending') {
            this.scanForShellMarker(data);
        }
        // Broadcast to attached clients
        for (const client of this.attachedClients) {
            client.onData(data);
        }
    }
    handleSubprocessExit(code) {
        if (this._disposed) {
            return;
        }
        this._exitCode = code;
        this._state = 'exited';
        if (this.killTimer) {
            clearTimeout(this.killTimer);
            this.killTimer = null;
        }
        if (this.shellReadyTimer) {
            clearTimeout(this.shellReadyTimer);
            this.shellReadyTimer = null;
        }
        for (const client of this.attachedClients) {
            client.onExit(code);
        }
    }
    scanForShellMarker(data) {
        this.markerBuffer += data;
        const markerIdx = this.markerBuffer.indexOf(SHELL_READY_MARKER);
        if (markerIdx !== -1) {
            this.markerBuffer = '';
            this.transitionToReady();
            return;
        }
        // Keep only the tail that could be the start of a partial marker match
        const maxPartial = SHELL_READY_MARKER.length - 1;
        if (this.markerBuffer.length > maxPartial) {
            this.markerBuffer = this.markerBuffer.slice(-maxPartial);
        }
    }
    transitionToReady() {
        this._shellState = 'ready';
        if (this.shellReadyTimer) {
            clearTimeout(this.shellReadyTimer);
            this.shellReadyTimer = null;
        }
        this.flushPreReadyQueue();
    }
    onShellReadyTimeout() {
        this.shellReadyTimer = null;
        if (this._shellState !== 'pending') {
            return;
        }
        this._shellState = 'timed_out';
        this.flushPreReadyQueue();
    }
    flushPreReadyQueue() {
        const queued = this.preReadyStdinQueue;
        this.preReadyStdinQueue = [];
        for (const data of queued) {
            this.subprocess.write(data);
        }
    }
    forceDispose() {
        if (this._state === 'exited') {
            return;
        }
        this.subprocess.forceKill();
        this._disposed = true;
        this._exitCode = -1;
        this._state = 'exited';
        this._isTerminating = false;
        if (this.shellReadyTimer) {
            clearTimeout(this.shellReadyTimer);
            this.shellReadyTimer = null;
        }
        if (this.killTimer) {
            clearTimeout(this.killTimer);
            this.killTimer = null;
        }
        const clients = this.attachedClients;
        this.attachedClients = [];
        this.preReadyStdinQueue = [];
        this.emulator.dispose();
        for (const client of clients) {
            client.onExit(-1);
        }
    }
}
