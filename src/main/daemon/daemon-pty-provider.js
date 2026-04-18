import { DaemonClient } from './client';
export class DaemonPtyProvider {
    client;
    dataListeners = [];
    exitListeners = [];
    removeEventListener = null;
    constructor(opts) {
        this.client = new DaemonClient({
            socketPath: opts.socketPath,
            tokenPath: opts.tokenPath
        });
    }
    async spawn(opts) {
        await this.client.ensureConnected();
        this.setupEventRouting();
        const result = await this.client.request('createOrAttach', {
            sessionId: opts.sessionId,
            cols: opts.cols,
            rows: opts.rows,
            cwd: opts.cwd,
            env: opts.env,
            command: opts.command
        });
        return {
            id: opts.sessionId,
            isNew: result.isNew,
            pid: result.pid
        };
    }
    write(id, data) {
        this.client.notify('write', { sessionId: id, data });
    }
    resize(id, cols, rows) {
        this.client.notify('resize', { sessionId: id, cols, rows });
    }
    async shutdown(id, _immediate) {
        await this.client.request('kill', { sessionId: id });
    }
    onData(callback) {
        this.dataListeners.push(callback);
        return () => {
            const idx = this.dataListeners.indexOf(callback);
            if (idx !== -1) {
                this.dataListeners.splice(idx, 1);
            }
        };
    }
    onExit(callback) {
        this.exitListeners.push(callback);
        return () => {
            const idx = this.exitListeners.indexOf(callback);
            if (idx !== -1) {
                this.exitListeners.splice(idx, 1);
            }
        };
    }
    async cleanup() {
        this.removeEventListener?.();
        this.removeEventListener = null;
        this.client.disconnect();
    }
    setupEventRouting() {
        if (this.removeEventListener) {
            return;
        }
        this.removeEventListener = this.client.onEvent((raw) => {
            const event = raw;
            if (event.type !== 'event') {
                return;
            }
            if (event.event === 'data') {
                for (const listener of this.dataListeners) {
                    listener({ id: event.sessionId, data: event.payload.data });
                }
            }
            else if (event.event === 'exit') {
                for (const listener of this.exitListeners) {
                    listener({ id: event.sessionId, code: event.payload.code });
                }
            }
        });
    }
}
