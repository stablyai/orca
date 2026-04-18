export class SshFilesystemProvider {
    connectionId;
    mux;
    // Why: each watch() call registers for a specific rootPath, but the relay
    // sends all fs.changed events on one notification channel. Keying by rootPath
    // prevents cross-pollination between different worktree watchers.
    watchListeners = new Map();
    // Why: store the unsubscribe handle so dispose() can detach from the
    // multiplexer. Without this, notification callbacks keep firing after
    // the provider is torn down on disconnect, routing events to stale state.
    unsubscribeNotifications = null;
    constructor(connectionId, mux) {
        this.connectionId = connectionId;
        this.mux = mux;
        this.unsubscribeNotifications = mux.onNotification((method, params) => {
            if (method === 'fs.changed') {
                const events = params.events;
                for (const [rootPath, cb] of this.watchListeners) {
                    const matching = events.filter((e) => e.absolutePath.startsWith(rootPath));
                    if (matching.length > 0) {
                        cb(matching);
                    }
                }
            }
        });
    }
    dispose() {
        if (this.unsubscribeNotifications) {
            this.unsubscribeNotifications();
            this.unsubscribeNotifications = null;
        }
        this.watchListeners.clear();
    }
    getConnectionId() {
        return this.connectionId;
    }
    async readDir(dirPath) {
        return (await this.mux.request('fs.readDir', { dirPath }));
    }
    async readFile(filePath) {
        return (await this.mux.request('fs.readFile', { filePath }));
    }
    async writeFile(filePath, content) {
        await this.mux.request('fs.writeFile', { filePath, content });
    }
    async stat(filePath) {
        return (await this.mux.request('fs.stat', { filePath }));
    }
    async deletePath(targetPath, recursive) {
        await this.mux.request('fs.deletePath', { targetPath, recursive });
    }
    async createFile(filePath) {
        await this.mux.request('fs.createFile', { filePath });
    }
    async createDir(dirPath) {
        await this.mux.request('fs.createDir', { dirPath });
    }
    async rename(oldPath, newPath) {
        await this.mux.request('fs.rename', { oldPath, newPath });
    }
    async copy(source, destination) {
        await this.mux.request('fs.copy', { source, destination });
    }
    async realpath(filePath) {
        return (await this.mux.request('fs.realpath', { filePath }));
    }
    async search(opts) {
        return (await this.mux.request('fs.search', opts));
    }
    async listFiles(rootPath) {
        return (await this.mux.request('fs.listFiles', { rootPath }));
    }
    async watch(rootPath, callback) {
        this.watchListeners.set(rootPath, callback);
        await this.mux.request('fs.watch', { rootPath });
        return () => {
            this.watchListeners.delete(rootPath);
            // Why: each watch() starts a @parcel/watcher on the relay for this specific
            // rootPath. We must always notify the relay to stop it, not only when all
            // watchers are gone — otherwise the remote watcher leaks inotify descriptors.
            this.mux.notify('fs.unwatch', { rootPath });
        };
    }
}
