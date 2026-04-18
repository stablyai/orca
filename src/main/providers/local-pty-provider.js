/* eslint-disable max-lines -- Why: shell-ready startup command integration adds
~70 lines of scanner/promise wiring to spawn(). Splitting the method would scatter
tightly coupled PTY lifecycle logic (scan → ready → write → exit cleanup) across
files without a cleaner ownership seam. */
import { basename, win32 as pathWin32 } from 'path';
import { existsSync } from 'fs';
import * as pty from 'node-pty';
import { parseWslPath } from '../wsl';
import { injectHistoryEnv, updateHistFileForFallback, logHistoryInjection } from '../terminal-history';
import { ensureNodePtySpawnHelperExecutable, validateWorkingDirectory, spawnShellWithFallback } from './local-pty-utils';
import { getShellReadyLaunchConfig, createShellReadyScanState, scanForShellReady, writeStartupCommandWhenShellReady, STARTUP_COMMAND_READY_MAX_WAIT_MS } from './local-pty-shell-ready';
let ptyCounter = 0;
const ptyProcesses = new Map();
const ptyShellName = new Map();
// Why: node-pty's onData/onExit register native NAPI ThreadSafeFunction
// callbacks. If the PTY is killed without disposing these listeners, the
// stale callbacks survive into node::FreeEnvironment() where NAPI attempts
// to invoke/clean them up on a destroyed environment, triggering a SIGABRT.
const ptyDisposables = new Map();
let loadGeneration = 0;
const ptyLoadGeneration = new Map();
const dataListeners = new Set();
const exitListeners = new Set();
function getDefaultCwd() {
    if (process.platform !== 'win32') {
        return process.env.HOME || '/';
    }
    // Why: USERPROFILE is not guaranteed in all Windows launch contexts.
    // Falling back to bare HOMEPATH yields a drive-relative path, so combine
    // HOMEDRIVE + HOMEPATH to keep spawned PTYs anchored to the intended home.
    if (process.env.USERPROFILE) {
        return process.env.USERPROFILE;
    }
    if (process.env.HOMEDRIVE && process.env.HOMEPATH) {
        return `${process.env.HOMEDRIVE}${process.env.HOMEPATH}`;
    }
    return 'C:\\';
}
function disposePtyListeners(id) {
    const disposables = ptyDisposables.get(id);
    if (disposables) {
        for (const d of disposables) {
            d.dispose();
        }
        ptyDisposables.delete(id);
    }
}
function clearPtyState(id) {
    disposePtyListeners(id);
    ptyProcesses.delete(id);
    ptyShellName.delete(id);
    ptyLoadGeneration.delete(id);
}
function safeKillAndClean(id, proc) {
    disposePtyListeners(id);
    try {
        proc.kill();
    }
    catch {
        /* Process may already be dead */
    }
    clearPtyState(id);
}
export class LocalPtyProvider {
    opts;
    constructor(opts = {}) {
        this.opts = opts;
    }
    /** Reconfigure the provider with new hooks (e.g. after window re-creation). */
    configure(opts) {
        this.opts = opts;
    }
    async spawn(args) {
        const id = String(++ptyCounter);
        const defaultCwd = getDefaultCwd();
        const cwd = args.cwd || defaultCwd;
        const wslInfo = process.platform === 'win32' ? parseWslPath(cwd) : null;
        let shellPath;
        let shellArgs;
        let effectiveCwd;
        let validationCwd;
        let shellReadyLaunch = null;
        if (wslInfo) {
            const escapedCwd = wslInfo.linuxPath.replace(/'/g, "'\\''");
            shellPath = 'wsl.exe';
            shellArgs = ['-d', wslInfo.distro, '--', 'bash', '-c', `cd '${escapedCwd}' && exec bash -l`];
            effectiveCwd = getDefaultCwd();
            validationCwd = cwd;
        }
        else if (process.platform === 'win32') {
            shellPath = process.env.COMSPEC || 'powershell.exe';
            // Why: use path.win32.basename so backslash-separated Windows paths
            // are parsed correctly even when tests mock process.platform on Linux CI.
            const shellBasename = pathWin32.basename(shellPath).toLowerCase();
            // Why: On CJK Windows (Chinese, Japanese, Korean), the console code page
            // defaults to the system ANSI code page (e.g. 936/GBK for Chinese).
            // ConPTY encodes its output pipe using this code page, but node-pty
            // always decodes as UTF-8. Without switching to code page 65001 (UTF-8),
            // multi-byte CJK characters are garbled because the GBK/Shift-JIS/EUC-KR
            // byte sequences are misinterpreted as UTF-8.
            if (shellBasename === 'cmd.exe') {
                shellArgs = ['/K', 'chcp 65001 > nul'];
            }
            else if (shellBasename === 'powershell.exe' || shellBasename === 'pwsh.exe') {
                // Why: `-NoExit -Command` alone skips the user's $PROFILE, breaking
                // custom prompts (oh-my-posh, starship), aliases, and PSReadLine
                // configuration. Dot-sourcing $PROFILE first restores the normal
                // startup experience.
                shellArgs = [
                    '-NoExit',
                    '-Command',
                    'try { . $PROFILE } catch {}; [Console]::OutputEncoding = [System.Text.Encoding]::UTF8; [Console]::InputEncoding = [System.Text.Encoding]::UTF8'
                ];
            }
            else {
                shellArgs = [];
            }
            effectiveCwd = cwd;
            validationCwd = cwd;
        }
        else {
            shellPath = args.env?.SHELL || process.env.SHELL || '/bin/zsh';
            shellReadyLaunch = args.command ? getShellReadyLaunchConfig(shellPath) : null;
            shellArgs = shellReadyLaunch?.args ?? ['-l'];
            effectiveCwd = cwd;
            validationCwd = cwd;
        }
        ensureNodePtySpawnHelperExecutable();
        validateWorkingDirectory(validationCwd);
        const spawnEnv = {
            ...process.env,
            ...args.env,
            ...shellReadyLaunch?.env,
            TERM: 'xterm-256color',
            COLORTERM: 'truecolor',
            TERM_PROGRAM: 'Orca',
            FORCE_HYPERLINK: '1'
        };
        spawnEnv.LANG ??= 'en_US.UTF-8';
        // Why: On Windows, LANG alone does not control the console code page.
        // Programs like Python and Node.js check their own encoding env vars
        // independently. PYTHONUTF8=1 makes Python use UTF-8 for stdio regardless
        // of the Windows console code page, preventing garbled CJK output from
        // Python scripts run inside the terminal.
        if (process.platform === 'win32') {
            spawnEnv.PYTHONUTF8 ??= '1';
        }
        const finalEnv = this.opts.buildSpawnEnv ? this.opts.buildSpawnEnv(id, spawnEnv) : spawnEnv;
        // ── Worktree-scoped shell history (§7–§10 of terminal-history-scope-design) ──
        // Why: without this, all worktree terminals share a single global HISTFILE
        // so ArrowUp in worktree B surfaces commands from worktree A.
        const worktreeId = args.worktreeId;
        const historyEnabled = worktreeId && (this.opts.isHistoryEnabled?.() ?? true);
        // Resolve the effective shell kind for history injection. For WSL, the
        // outer executable is wsl.exe but the inner login shell is bash.
        const effectiveShellPath = wslInfo ? 'bash' : shellPath;
        let historyResult = null;
        if (historyEnabled) {
            historyResult = injectHistoryEnv(finalEnv, worktreeId, effectiveShellPath, cwd);
            logHistoryInjection(worktreeId, historyResult);
        }
        const spawnResult = spawnShellWithFallback({
            shellPath,
            shellArgs,
            cols: args.cols,
            rows: args.rows,
            cwd: effectiveCwd,
            env: finalEnv,
            ptySpawn: pty.spawn,
            getShellReadyConfig: args.command ? (shell) => getShellReadyLaunchConfig(shell) : undefined,
            // Why: if zsh failed and bash took over, HISTFILE still points to
            // zsh_history. Update it *before* spawn so the child inherits the
            // correct filename (see design doc §8).
            onBeforeFallbackSpawn: historyResult?.histFile
                ? (env, fallbackShell) => updateHistFileForFallback(env, fallbackShell)
                : undefined
        });
        shellPath = spawnResult.shellPath;
        if (process.platform !== 'win32') {
            finalEnv.SHELL = shellPath;
        }
        const proc = spawnResult.process;
        ptyProcesses.set(id, proc);
        ptyShellName.set(id, basename(shellPath));
        ptyLoadGeneration.set(id, loadGeneration);
        this.opts.onSpawned?.(id);
        // Shell-ready startup command support
        let resolveShellReady = null;
        let shellReadyTimeout = null;
        const shellReadyScanState = shellReadyLaunch?.supportsReadyMarker
            ? createShellReadyScanState()
            : null;
        const shellReadyPromise = args.command
            ? new Promise((resolve) => {
                resolveShellReady = resolve;
            })
            : Promise.resolve();
        const finishShellReady = () => {
            if (!resolveShellReady) {
                return;
            }
            if (shellReadyTimeout) {
                clearTimeout(shellReadyTimeout);
                shellReadyTimeout = null;
            }
            const resolve = resolveShellReady;
            resolveShellReady = null;
            resolve();
        };
        if (args.command) {
            if (shellReadyLaunch?.supportsReadyMarker) {
                shellReadyTimeout = setTimeout(() => {
                    finishShellReady();
                }, STARTUP_COMMAND_READY_MAX_WAIT_MS);
            }
            else {
                finishShellReady();
            }
        }
        let startupCommandCleanup = null;
        const disposables = [];
        const onDataDisposable = proc.onData((rawData) => {
            let data = rawData;
            if (shellReadyScanState && resolveShellReady) {
                const scanned = scanForShellReady(shellReadyScanState, rawData);
                data = scanned.output;
                if (scanned.matched) {
                    finishShellReady();
                }
            }
            if (data.length === 0) {
                return;
            }
            this.opts.onData?.(id, data, Date.now());
            for (const cb of dataListeners) {
                cb({ id, data });
            }
        });
        if (onDataDisposable) {
            disposables.push(onDataDisposable);
        }
        const onExitDisposable = proc.onExit(({ exitCode }) => {
            if (shellReadyTimeout) {
                clearTimeout(shellReadyTimeout);
                shellReadyTimeout = null;
            }
            startupCommandCleanup?.();
            clearPtyState(id);
            this.opts.onExit?.(id, exitCode);
            for (const cb of exitListeners) {
                cb({ id, code: exitCode });
            }
        });
        if (onExitDisposable) {
            disposables.push(onExitDisposable);
        }
        ptyDisposables.set(id, disposables);
        if (args.command) {
            writeStartupCommandWhenShellReady(shellReadyPromise, proc, args.command, (cleanup) => {
                startupCommandCleanup = cleanup;
            });
        }
        return { id };
    }
    // Local PTYs are always attached -- no-op. Remote providers use this to resubscribe.
    async attach(_id) { }
    write(id, data) {
        ptyProcesses.get(id)?.write(data);
    }
    resize(id, cols, rows) {
        ptyProcesses.get(id)?.resize(cols, rows);
    }
    async shutdown(id, _immediate) {
        const proc = ptyProcesses.get(id);
        if (!proc) {
            return;
        }
        // Why: disposePtyListeners removes the onExit callback, so the natural
        // exit cleanup path from node-pty won't fire. Cleanup and notification
        // must happen unconditionally after the try/catch.
        // Note: clearPtyState calls disposePtyListeners internally, so we only
        // need to call it once via clearPtyState after killing the process.
        disposePtyListeners(id);
        try {
            proc.kill();
        }
        catch {
            /* Process may already be dead */
        }
        ptyProcesses.delete(id);
        ptyShellName.delete(id);
        ptyLoadGeneration.delete(id);
        this.opts.onExit?.(id, -1);
        for (const cb of exitListeners) {
            cb({ id, code: -1 });
        }
    }
    async sendSignal(id, signal) {
        const proc = ptyProcesses.get(id);
        if (!proc) {
            return;
        }
        try {
            process.kill(proc.pid, signal);
        }
        catch {
            /* Process may already be dead */
        }
    }
    async getCwd(id) {
        if (!ptyProcesses.has(id)) {
            throw new Error(`PTY ${id} not found`);
        }
        // node-pty doesn't expose cwd; would need /proc on Linux or lsof on macOS
        return '';
    }
    async getInitialCwd(_id) {
        return '';
    }
    async clearBuffer(_id) {
        /* handled client-side in xterm.js */
    }
    acknowledgeDataEvent(_id, _charCount) {
        /* no flow control for local */
    }
    async hasChildProcesses(id) {
        const proc = ptyProcesses.get(id);
        if (!proc) {
            return false;
        }
        try {
            const foreground = proc.process;
            const shell = ptyShellName.get(id);
            if (!shell) {
                return true;
            }
            return foreground !== shell;
        }
        catch {
            return false;
        }
    }
    async getForegroundProcess(id) {
        const proc = ptyProcesses.get(id);
        if (!proc) {
            return null;
        }
        try {
            return proc.process || null;
        }
        catch {
            return null;
        }
    }
    async serialize(_ids) {
        return '{}';
    }
    async revive(_state) {
        /* re-spawning handles local revival */
    }
    async listProcesses() {
        return Array.from(ptyProcesses.entries()).map(([id, proc]) => ({
            id,
            cwd: '',
            title: proc.process || ptyShellName.get(id) || 'shell'
        }));
    }
    async getDefaultShell() {
        if (process.platform === 'win32') {
            return process.env.COMSPEC || 'powershell.exe';
        }
        return process.env.SHELL || '/bin/zsh';
    }
    async getProfiles() {
        if (process.platform === 'win32') {
            return [
                { name: 'PowerShell', path: 'powershell.exe' },
                { name: 'Command Prompt', path: 'cmd.exe' }
            ];
        }
        const shells = ['/bin/zsh', '/bin/bash', '/bin/sh'];
        return shells.filter((s) => existsSync(s)).map((s) => ({ name: basename(s), path: s }));
    }
    onData(callback) {
        dataListeners.add(callback);
        return () => dataListeners.delete(callback);
    }
    // Local PTYs don't replay -- this is for remote reconnection
    onReplay(_callback) {
        return () => { };
    }
    onExit(callback) {
        exitListeners.add(callback);
        return () => exitListeners.delete(callback);
    }
    // ─── Local-only helpers (not part of IPtyProvider interface) ───────
    /** Kill orphaned PTYs from previous page loads. */
    killOrphanedPtys(currentGeneration) {
        const killed = [];
        for (const [id, proc] of ptyProcesses) {
            if ((ptyLoadGeneration.get(id) ?? -1) < currentGeneration) {
                safeKillAndClean(id, proc);
                killed.push({ id });
            }
        }
        return killed;
    }
    /** Advance the load generation counter (called on renderer reload). */
    advanceGeneration() {
        return ++loadGeneration;
    }
    /** Get a writable reference to a PTY (for runtime controller). */
    getPtyProcess(id) {
        return ptyProcesses.get(id);
    }
    /** Kill all PTYs. Call on app quit. */
    killAll() {
        for (const [id, proc] of ptyProcesses) {
            safeKillAndClean(id, proc);
        }
    }
}
