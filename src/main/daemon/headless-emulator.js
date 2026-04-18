import './xterm-env-polyfill';
import { Terminal } from '@xterm/headless';
import { SerializeAddon } from '@xterm/addon-serialize';
const DEFAULT_SCROLLBACK = 5000;
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
        // Why: Windows OSC-7 cwd updates can describe both drive-letter paths
        // (`file:///C:/repo`) and UNC shares (`file://server/share/repo`). Use the
        // hostname when present so live cwd tracking, snapshots, and restore all
        // round-trip to a native Windows path instead of dropping the server name.
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
export class HeadlessEmulator {
    terminal;
    serializer;
    cwd = null;
    disposed = false;
    constructor(opts) {
        this.terminal = new Terminal({
            cols: opts.cols,
            rows: opts.rows,
            scrollback: opts.scrollback ?? DEFAULT_SCROLLBACK,
            allowProposedApi: true
        });
        this.serializer = new SerializeAddon();
        this.terminal.loadAddon(this.serializer);
        if (opts.onData) {
            this.terminal.onData(opts.onData);
        }
    }
    write(data) {
        if (this.disposed) {
            return Promise.resolve();
        }
        this.scanOsc7(data);
        return new Promise((resolve) => {
            this.terminal.write(data, resolve);
        });
    }
    resize(cols, rows) {
        if (this.disposed) {
            return;
        }
        this.terminal.resize(cols, rows);
    }
    getSnapshot() {
        const modes = this.getModes();
        return {
            snapshotAnsi: this.serializer.serialize(),
            scrollbackAnsi: '',
            rehydrateSequences: this.buildRehydrateSequences(modes),
            cwd: this.cwd,
            modes,
            cols: this.terminal.cols,
            rows: this.terminal.rows,
            scrollbackLines: this.terminal.buffer.normal.length - this.terminal.rows
        };
    }
    get isAlternateScreen() {
        return this.terminal.buffer.active.type === 'alternate';
    }
    getCwd() {
        return this.cwd;
    }
    clearScrollback() {
        this.terminal.clear();
    }
    dispose() {
        this.disposed = true;
        this.terminal.dispose();
    }
    scanOsc7(data) {
        // OSC-7 format: ESC ] 7 ; <uri> BEL  or  ESC ] 7 ; <uri> ST
        // BEL = \x07, ST = ESC \
        // oxlint-disable-next-line no-control-regex -- terminal escape sequences require control chars
        const osc7Re = /\x1b\]7;([^\x07\x1b]*?)(?:\x07|\x1b\\)/g;
        let match;
        while ((match = osc7Re.exec(data)) !== null) {
            this.parseOsc7Uri(match[1]);
        }
    }
    parseOsc7Uri(uri) {
        const parsed = parseFileUriPath(uri);
        if (parsed) {
            this.cwd = parsed;
        }
    }
    getModes() {
        const buffer = this.terminal.buffer.active;
        return {
            bracketedPaste: this.terminal.modes.bracketedPasteMode,
            mouseTracking: this.terminal.modes.mouseTrackingMode !== 'none',
            applicationCursor: buffer.type === 'normal' ? this.terminal.modes.applicationCursorKeysMode : false,
            alternateScreen: buffer.type === 'alternate'
        };
    }
    buildRehydrateSequences(modes) {
        const seqs = [];
        if (modes.bracketedPaste) {
            seqs.push('\x1b[?2004h');
        }
        if (modes.applicationCursor) {
            seqs.push('\x1b[?1h');
        }
        if (modes.alternateScreen) {
            seqs.push('\x1b[?1049h');
        }
        return seqs.join('');
    }
}
