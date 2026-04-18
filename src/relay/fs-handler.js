import { readdir, readFile, writeFile, stat, lstat, mkdir, rename, cp, rm, realpath } from 'fs/promises';
import { extname } from 'path';
import { MAX_FILE_SIZE, DEFAULT_MAX_RESULTS, IMAGE_MIME_TYPES, isBinaryBuffer, searchWithRg, listFilesWithRg } from './fs-handler-utils';
export class FsHandler {
    dispatcher;
    context;
    watches = new Map();
    constructor(dispatcher, context) {
        this.dispatcher = dispatcher;
        this.context = context;
        this.registerHandlers();
    }
    registerHandlers() {
        this.dispatcher.onRequest('fs.readDir', (p) => this.readDir(p));
        this.dispatcher.onRequest('fs.readFile', (p) => this.readFile(p));
        this.dispatcher.onRequest('fs.writeFile', (p) => this.writeFile(p));
        this.dispatcher.onRequest('fs.stat', (p) => this.stat(p));
        this.dispatcher.onRequest('fs.deletePath', (p) => this.deletePath(p));
        this.dispatcher.onRequest('fs.createFile', (p) => this.createFile(p));
        this.dispatcher.onRequest('fs.createDir', (p) => this.createDir(p));
        this.dispatcher.onRequest('fs.rename', (p) => this.rename(p));
        this.dispatcher.onRequest('fs.copy', (p) => this.copy(p));
        this.dispatcher.onRequest('fs.realpath', (p) => this.realpath(p));
        this.dispatcher.onRequest('fs.search', (p) => this.search(p));
        this.dispatcher.onRequest('fs.listFiles', (p) => this.listFiles(p));
        this.dispatcher.onRequest('fs.watch', (p) => this.watch(p));
        this.dispatcher.onNotification('fs.unwatch', (p) => this.unwatch(p));
    }
    async readDir(params) {
        const dirPath = params.dirPath;
        await this.context.validatePathResolved(dirPath);
        const entries = await readdir(dirPath, { withFileTypes: true });
        return entries
            .map((entry) => ({
            name: entry.name,
            isDirectory: entry.isDirectory(),
            isSymlink: entry.isSymbolicLink()
        }))
            .sort((a, b) => {
            if (a.isDirectory !== b.isDirectory) {
                return a.isDirectory ? -1 : 1;
            }
            return a.name.localeCompare(b.name);
        });
    }
    async readFile(params) {
        const filePath = params.filePath;
        await this.context.validatePathResolved(filePath);
        const stats = await stat(filePath);
        if (stats.size > MAX_FILE_SIZE) {
            throw new Error(`File too large: ${(stats.size / 1024 / 1024).toFixed(1)}MB exceeds ${MAX_FILE_SIZE / 1024 / 1024}MB limit`);
        }
        const buffer = await readFile(filePath);
        const mimeType = IMAGE_MIME_TYPES[extname(filePath).toLowerCase()];
        if (mimeType) {
            return { content: buffer.toString('base64'), isBinary: true, isImage: true, mimeType };
        }
        if (isBinaryBuffer(buffer)) {
            return { content: '', isBinary: true };
        }
        return { content: buffer.toString('utf-8'), isBinary: false };
    }
    async writeFile(params) {
        const filePath = params.filePath;
        await this.context.validatePathResolved(filePath);
        const content = params.content;
        try {
            const fileStats = await lstat(filePath);
            if (fileStats.isDirectory()) {
                throw new Error('Cannot write to a directory');
            }
        }
        catch (error) {
            if (error.code !== 'ENOENT') {
                throw error;
            }
        }
        await writeFile(filePath, content, 'utf-8');
    }
    async stat(params) {
        const filePath = params.filePath;
        await this.context.validatePathResolved(filePath);
        // Why: lstat is used instead of stat so that symlinks are reported as
        // symlinks rather than being silently followed. stat() follows symlinks,
        // meaning isSymbolicLink() would always return false.
        const stats = await lstat(filePath);
        let type = 'file';
        if (stats.isDirectory()) {
            type = 'directory';
        }
        else if (stats.isSymbolicLink()) {
            type = 'symlink';
        }
        return { size: stats.size, type, mtime: stats.mtimeMs };
    }
    async deletePath(params) {
        const targetPath = params.targetPath;
        await this.context.validatePathResolved(targetPath);
        const recursive = params.recursive;
        const stats = await stat(targetPath);
        if (stats.isDirectory() && !recursive) {
            throw new Error('Cannot delete directory without recursive flag');
        }
        await rm(targetPath, { recursive: !!recursive, force: true });
    }
    async createFile(params) {
        const filePath = params.filePath;
        // Why: symlinks in parent directories can redirect creation outside the
        // workspace. validatePathResolved follows symlinks before checking roots.
        await this.context.validatePathResolved(filePath);
        const { dirname } = await import('path');
        await mkdir(dirname(filePath), { recursive: true });
        await writeFile(filePath, '', { encoding: 'utf-8', flag: 'wx' });
    }
    async createDir(params) {
        const dirPath = params.dirPath;
        await this.context.validatePathResolved(dirPath);
        await mkdir(dirPath, { recursive: true });
    }
    async rename(params) {
        const oldPath = params.oldPath;
        const newPath = params.newPath;
        await this.context.validatePathResolved(oldPath);
        await this.context.validatePathResolved(newPath);
        await rename(oldPath, newPath);
    }
    async copy(params) {
        const source = params.source;
        const destination = params.destination;
        // Why: cp follows symlinks — a symlink inside the workspace pointing to
        // /etc would copy sensitive files into the workspace where readFile can
        // exfiltrate them.
        await this.context.validatePathResolved(source);
        await this.context.validatePathResolved(destination);
        await cp(source, destination, { recursive: true });
    }
    async realpath(params) {
        const filePath = params.filePath;
        this.context.validatePath(filePath);
        const resolved = await realpath(filePath);
        // Why: a symlink inside the workspace may resolve to a path outside it.
        // Returning the resolved path without validation leaks the external target.
        this.context.validatePath(resolved);
        return resolved;
    }
    async search(params) {
        const query = params.query;
        const rootPath = params.rootPath;
        // Why: a symlink inside the workspace pointing to a directory outside it
        // would let rg search (and return content from) files beyond the workspace.
        await this.context.validatePathResolved(rootPath);
        const caseSensitive = params.caseSensitive;
        const wholeWord = params.wholeWord;
        const useRegex = params.useRegex;
        const includePattern = params.includePattern;
        const excludePattern = params.excludePattern;
        const maxResults = Math.min(params.maxResults || DEFAULT_MAX_RESULTS, DEFAULT_MAX_RESULTS);
        return searchWithRg(rootPath, query, {
            caseSensitive,
            wholeWord,
            useRegex,
            includePattern,
            excludePattern,
            maxResults
        });
    }
    async listFiles(params) {
        const rootPath = params.rootPath;
        await this.context.validatePathResolved(rootPath);
        return listFilesWithRg(rootPath);
    }
    async watch(params) {
        const rootPath = params.rootPath;
        this.context.validatePath(rootPath);
        if (this.watches.size >= 20) {
            throw new Error('Maximum number of file watchers reached');
        }
        if (this.watches.has(rootPath)) {
            return;
        }
        const watchState = { rootPath, unwatchFn: null };
        this.watches.set(rootPath, watchState);
        try {
            const watcher = await import('@parcel/watcher');
            const subscription = await watcher.subscribe(rootPath, (err, events) => {
                if (err) {
                    this.dispatcher.notify('fs.changed', {
                        events: [{ kind: 'overflow', absolutePath: rootPath }]
                    });
                    return;
                }
                const mapped = events.map((evt) => ({
                    kind: evt.type,
                    absolutePath: evt.path
                }));
                this.dispatcher.notify('fs.changed', { events: mapped });
            }, { ignore: ['.git', 'node_modules', 'dist', 'build', '.next', '.cache', '__pycache__'] });
            watchState.unwatchFn = () => {
                void subscription.unsubscribe();
            };
        }
        catch {
            // @parcel/watcher not available -- polling fallback would go here
            process.stderr.write('[relay] File watcher not available, fs.changed events disabled\n');
        }
    }
    unwatch(params) {
        const rootPath = params.rootPath;
        const state = this.watches.get(rootPath);
        if (state) {
            state.unwatchFn?.();
            this.watches.delete(rootPath);
        }
    }
    dispose() {
        for (const [, state] of this.watches) {
            state.unwatchFn?.();
        }
        this.watches.clear();
    }
}
