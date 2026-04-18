/**
 * Remote PTY provider that proxies all operations through the relay
 * via the JSON-RPC multiplexer. Implements the same IPtyProvider interface
 * as LocalPtyProvider so the dispatch layer can route transparently.
 */
export class SshPtyProvider {
    mux;
    connectionId;
    dataListeners = new Set();
    replayListeners = new Set();
    exitListeners = new Set();
    // Why: store the unsubscribe handle so dispose() can detach from the
    // multiplexer. Without this, notification callbacks keep firing after
    // the provider is torn down on disconnect, routing events to stale state.
    unsubscribeNotifications = null;
    constructor(connectionId, mux) {
        this.connectionId = connectionId;
        this.mux = mux;
        // Subscribe to relay notifications for PTY events
        this.unsubscribeNotifications = mux.onNotification((method, params) => {
            switch (method) {
                case 'pty.data':
                    for (const cb of this.dataListeners) {
                        cb({ id: params.id, data: params.data });
                    }
                    break;
                case 'pty.replay':
                    for (const cb of this.replayListeners) {
                        cb({ id: params.id, data: params.data });
                    }
                    break;
                case 'pty.exit':
                    for (const cb of this.exitListeners) {
                        cb({ id: params.id, code: params.code });
                    }
                    break;
            }
        });
    }
    dispose() {
        if (this.unsubscribeNotifications) {
            this.unsubscribeNotifications();
            this.unsubscribeNotifications = null;
        }
        this.dataListeners.clear();
        this.replayListeners.clear();
        this.exitListeners.clear();
    }
    getConnectionId() {
        return this.connectionId;
    }
    async spawn(opts) {
        const result = await this.mux.request('pty.spawn', {
            cols: opts.cols,
            rows: opts.rows,
            cwd: opts.cwd,
            env: opts.env
        });
        return result;
    }
    async attach(id) {
        await this.mux.request('pty.attach', { id });
    }
    write(id, data) {
        this.mux.notify('pty.data', { id, data });
    }
    resize(id, cols, rows) {
        this.mux.notify('pty.resize', { id, cols, rows });
    }
    async shutdown(id, immediate) {
        await this.mux.request('pty.shutdown', { id, immediate });
    }
    async sendSignal(id, signal) {
        await this.mux.request('pty.sendSignal', { id, signal });
    }
    async getCwd(id) {
        const result = await this.mux.request('pty.getCwd', { id });
        return result;
    }
    async getInitialCwd(id) {
        const result = await this.mux.request('pty.getInitialCwd', { id });
        return result;
    }
    async clearBuffer(id) {
        await this.mux.request('pty.clearBuffer', { id });
    }
    acknowledgeDataEvent(id, charCount) {
        this.mux.notify('pty.ackData', { id, charCount });
    }
    async hasChildProcesses(id) {
        const result = await this.mux.request('pty.hasChildProcesses', { id });
        return result;
    }
    async getForegroundProcess(id) {
        const result = await this.mux.request('pty.getForegroundProcess', { id });
        return result;
    }
    async serialize(ids) {
        const result = await this.mux.request('pty.serialize', { ids });
        return result;
    }
    async revive(state) {
        await this.mux.request('pty.revive', { state });
    }
    async listProcesses() {
        const result = await this.mux.request('pty.listProcesses');
        return result;
    }
    async getDefaultShell() {
        const result = await this.mux.request('pty.getDefaultShell');
        return result;
    }
    async getProfiles() {
        const result = await this.mux.request('pty.getProfiles');
        return result;
    }
    onData(callback) {
        this.dataListeners.add(callback);
        return () => this.dataListeners.delete(callback);
    }
    onReplay(callback) {
        this.replayListeners.add(callback);
        return () => this.replayListeners.delete(callback);
    }
    onExit(callback) {
        this.exitListeners.add(callback);
        return () => this.exitListeners.delete(callback);
    }
}
