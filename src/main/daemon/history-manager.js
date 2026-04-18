import { join } from 'path';
import { mkdirSync, writeFileSync, appendFileSync, readFileSync, existsSync, rmSync } from 'fs';
import { getHistorySessionDirName } from './history-paths';
const MAX_SCROLLBACK_BYTES = 5 * 1024 * 1024;
function parseFileUriPath(uri) {
    try {
        const url = new URL(uri);
        if (url.protocol !== 'file:') {
            return null;
        }
        const decodedPath = decodeURIComponent(url.pathname);
        if (process.platform !== 'win32') {
            return decodedPath;
        }
        // Why: daemon-side cwd persistence must preserve the full Windows target
        // path from OSC-7, including UNC hosts, or cold restore can reopen in a
        // different directory than the live shell had reached before the crash.
        if (url.hostname) {
            return `\\\\${url.hostname}${decodedPath.replace(/\//g, '\\')}`;
        }
        if (/^\/[A-Za-z]:/.test(decodedPath)) {
            return decodedPath.slice(1);
        }
        return decodedPath.replace(/\//g, '\\');
    }
    catch {
        return null;
    }
}
export class HistoryManager {
    basePath;
    writers = new Map();
    disabledSessions = new Set();
    onWriteError;
    constructor(basePath, opts) {
        this.basePath = basePath;
        this.onWriteError = opts?.onWriteError;
    }
    async openSession(sessionId, opts) {
        try {
            this.disabledSessions.delete(sessionId);
            const dir = join(this.basePath, getHistorySessionDirName(sessionId));
            mkdirSync(dir, { recursive: true });
            const meta = {
                cwd: opts.cwd,
                cols: opts.cols,
                rows: opts.rows,
                startedAt: new Date().toISOString(),
                endedAt: null,
                exitCode: null
            };
            writeFileSync(join(dir, 'meta.json'), JSON.stringify(meta, null, 2));
            const scrollbackPath = join(dir, 'scrollback.bin');
            let bytesWritten = 0;
            if (opts.initialScrollback) {
                writeFileSync(scrollbackPath, opts.initialScrollback);
                bytesWritten = Buffer.byteLength(opts.initialScrollback);
            }
            else {
                writeFileSync(scrollbackPath, '');
            }
            this.writers.set(sessionId, {
                dir,
                scrollbackPath,
                bytesWritten,
                cwd: opts.cwd,
                partialEscape: ''
            });
        }
        catch (err) {
            this.handleWriteError(sessionId, err);
        }
    }
    async appendData(sessionId, data) {
        if (this.disabledSessions.has(sessionId)) {
            return;
        }
        const writer = this.writers.get(sessionId);
        if (!writer) {
            return;
        }
        try {
            const combined = writer.partialEscape + data;
            writer.partialEscape = '';
            const nextCwd = this.extractLatestCwd(combined);
            if (nextCwd && nextCwd !== writer.cwd) {
                writer.cwd = nextCwd;
                this.updateMeta(writer.dir, { cwd: nextCwd });
            }
            // Why: use lastIndexOf so that multiple CSI 3J sequences in one chunk
            // reset to the content after the *last* clear, not the first.
            const clearIdx = combined.lastIndexOf('\x1b[3J');
            if (clearIdx !== -1) {
                const afterClear = combined.slice(clearIdx + 4);
                // Why: CSI 3J resets the byte counter — a clear after the 5MB cap
                // must still take effect, otherwise the on-disk history is stale.
                this.resetScrollback(writer);
                // Why: afterClear may itself end with a partial CSI 3J prefix
                // (e.g., the chunk was `...\x1b[3Jdata\x1b[`). Buffer it the
                // same way the main path does, otherwise the next chunk's
                // completion of the sequence won't be detected as a clear.
                const partial = this.trailingPartialCsi3J(afterClear);
                if (partial) {
                    writer.partialEscape = partial;
                    const safe = afterClear.slice(0, afterClear.length - partial.length);
                    if (safe.length > 0) {
                        this.writeChunk(writer, safe);
                    }
                }
                else if (afterClear.length > 0) {
                    this.writeChunk(writer, afterClear);
                }
                return;
            }
            // Why: CSI 3J detection (above) must run even when the cap is hit,
            // because a clear resets the byte counter. All other writes are
            // blocked once the cap is reached.
            if (writer.bytesWritten >= MAX_SCROLLBACK_BYTES) {
                return;
            }
            const partial = this.trailingPartialCsi3J(combined);
            if (partial) {
                writer.partialEscape = partial;
                const safe = combined.slice(0, combined.length - partial.length);
                if (safe.length > 0) {
                    this.writeChunk(writer, safe);
                }
                return;
            }
            this.writeChunk(writer, combined);
        }
        catch (err) {
            this.handleWriteError(sessionId, err);
        }
    }
    async closeSession(sessionId, exitCode) {
        const writer = this.writers.get(sessionId);
        if (!writer) {
            return;
        }
        this.writers.delete(sessionId);
        // Why: partialEscape may hold buffered bytes from a chunk boundary that
        // looked like a CSI 3J prefix. Flush them before closing so they aren't
        // silently dropped. (dispose() does the same flush.)
        if (writer.partialEscape) {
            try {
                this.writeChunk(writer, writer.partialEscape);
            }
            catch {
                // Best-effort flush — don't block session close
            }
            writer.partialEscape = '';
        }
        try {
            this.updateMeta(writer.dir, { endedAt: new Date().toISOString(), exitCode });
        }
        catch (err) {
            // Why: if endedAt can't be written, the session looks like an unclean
            // shutdown and triggers a false cold restore on next launch. Disable
            // further writes and report, but don't crash the app.
            this.handleWriteError(sessionId, err);
        }
    }
    async removeSession(sessionId) {
        this.writers.delete(sessionId);
        this.disabledSessions.delete(sessionId);
        rmSync(join(this.basePath, getHistorySessionDirName(sessionId)), {
            recursive: true,
            force: true
        });
    }
    hasHistory(sessionId) {
        return existsSync(join(this.basePath, getHistorySessionDirName(sessionId), 'meta.json'));
    }
    readMeta(sessionId) {
        const metaPath = join(this.basePath, getHistorySessionDirName(sessionId), 'meta.json');
        if (!existsSync(metaPath)) {
            return null;
        }
        try {
            return JSON.parse(readFileSync(metaPath, 'utf-8'));
        }
        catch {
            return null;
        }
    }
    async dispose() {
        // Why: mark all open sessions as cleanly ended so they don't trigger
        // false cold-restores on next launch. Flush any buffered partial escape
        // data before closing.
        for (const [sessionId, writer] of this.writers) {
            if (writer.partialEscape) {
                try {
                    this.writeChunk(writer, writer.partialEscape);
                }
                catch {
                    // Best-effort flush — don't block shutdown
                }
                writer.partialEscape = '';
            }
            try {
                this.updateMeta(writer.dir, { endedAt: new Date().toISOString(), exitCode: null });
            }
            catch {
                // Best-effort — don't block shutdown
                this.disabledSessions.add(sessionId);
            }
        }
        this.writers.clear();
    }
    writeChunk(writer, data) {
        const buf = Buffer.from(data);
        const remaining = MAX_SCROLLBACK_BYTES - writer.bytesWritten;
        if (remaining <= 0) {
            return;
        }
        if (buf.length > remaining) {
            appendFileSync(writer.scrollbackPath, buf.subarray(0, remaining));
            writer.bytesWritten = MAX_SCROLLBACK_BYTES;
        }
        else {
            appendFileSync(writer.scrollbackPath, buf);
            writer.bytesWritten += buf.length;
        }
    }
    resetScrollback(writer) {
        writeFileSync(writer.scrollbackPath, '');
        writer.bytesWritten = 0;
    }
    // Why: CSI 3J is 4 bytes (\x1b [ 3 J). If the chunk ends with a prefix
    // of this sequence, we must buffer it and check the next chunk.
    trailingPartialCsi3J(data) {
        const suffixes = ['\x1b[3', '\x1b[', '\x1b'];
        for (const suffix of suffixes) {
            if (data.endsWith(suffix)) {
                return suffix;
            }
        }
        return null;
    }
    extractLatestCwd(data) {
        // OSC-7 format: ESC ] 7 ; <uri> BEL  or  ESC ] 7 ; <uri> ST
        // oxlint-disable-next-line no-control-regex -- terminal escape sequences require control chars
        const osc7Re = /\x1b\]7;([^\x07\x1b]*?)(?:\x07|\x1b\\)/g;
        let match;
        let latest = null;
        while ((match = osc7Re.exec(data)) !== null) {
            latest = this.parseOsc7Uri(match[1]);
        }
        return latest;
    }
    parseOsc7Uri(uri) {
        return parseFileUriPath(uri);
    }
    // Why: history is best-effort — any error should disable the session
    // rather than crash the app. Callers use fire-and-forget `void` promises,
    // so a re-thrown error would become an unhandled rejection.
    handleWriteError(sessionId, err) {
        this.disabledSessions.add(sessionId);
        this.onWriteError?.(sessionId, err);
    }
    updateMeta(dir, updates) {
        const metaPath = join(dir, 'meta.json');
        let meta;
        try {
            meta = JSON.parse(readFileSync(metaPath, 'utf-8'));
        }
        catch {
            // meta.json missing or corrupt — nothing to update
            return;
        }
        Object.assign(meta, updates);
        writeFileSync(metaPath, JSON.stringify(meta, null, 2));
    }
}
