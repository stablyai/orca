import { app } from 'electron';
import { join } from 'path';
import { getVersionManagerBinPaths } from '../codex-cli/command';
const DEV_PARENT_SHUTDOWN_GRACE_MS = 3000;
function requestDevParentShutdown() {
    app.quit();
    const forceExitTimer = setTimeout(() => {
        // Why: in dev, losing the supervising parent means this Electron process is
        // already orphaned from the terminal session. We try app.quit() first so
        // normal cleanup still runs, but fall back to app.exit() when macOS quit
        // handlers or window-close guards stall and would otherwise leave Orca
        // hanging after Ctrl+C ends `pnpm dev`.
        app.exit(0);
    }, DEV_PARENT_SHUTDOWN_GRACE_MS);
    forceExitTimer.unref();
}
export function installUncaughtPipeErrorGuard() {
    process.on('uncaughtException', (error) => {
        if (error &&
            'code' in error &&
            (error.code === 'EIO' ||
                error.code === 'EPIPE')) {
            return;
        }
        throw error;
    });
}
export function patchPackagedProcessPath() {
    if (!app.isPackaged || process.platform === 'win32') {
        return;
    }
    const home = process.env.HOME ?? '';
    const extraPaths = [
        '/opt/homebrew/bin',
        '/opt/homebrew/sbin',
        '/usr/local/bin',
        '/usr/local/sbin',
        '/snap/bin',
        '/home/linuxbrew/.linuxbrew/bin',
        '/nix/var/nix/profiles/default/bin'
    ];
    if (home) {
        extraPaths.push(join(home, '.local/bin'), join(home, '.nix-profile/bin'));
    }
    // Why: CLI tools installed via Node version managers (nvm, volta, asdf, fnm,
    // pnpm, yarn, bun) use #!/usr/bin/env node shebangs that need `node` in PATH.
    // resolveCodexCommand() can locate the codex binary in these directories, but
    // spawning it still fails if node itself isn't in PATH. Adding version manager
    // bin paths here fixes all spawn sites (login, rate limits, usage tracking).
    extraPaths.push(...getVersionManagerBinPaths());
    const currentPath = process.env.PATH ?? '';
    const existing = new Set(currentPath.split(':'));
    const missing = extraPaths.filter((path) => !existing.has(path));
    if (missing.length > 0) {
        process.env.PATH = [...missing, ...currentPath.split(':').filter(Boolean)].join(':');
    }
}
export function configureDevUserDataPath(isDev) {
    if (!isDev) {
        return;
    }
    const overrideUserDataPath = process.env.ORCA_DEV_USER_DATA_PATH;
    if (overrideUserDataPath) {
        // Why: automated Electron repros need an isolated profile so persisted
        // tabs/worktrees from the developer's normal `orca-dev` session do not
        // change startup behavior and hide or create window-management bugs.
        app.setPath('userData', overrideUserDataPath);
        return;
    }
    // Why: development runs share the same machine as packaged Orca, and both
    // publish runtime bootstrap files under userData. Without a dev-only path,
    // `pnpm dev` can overwrite the packaged app's runtime pointer and make the
    // public `orca` CLI look broken even though the packaged app is still open.
    app.setPath('userData', join(app.getPath('appData'), 'orca-dev'));
}
export function installDevParentDisconnectQuit(isDev) {
    if (!isDev || typeof process.send !== 'function') {
        return;
    }
    // Why: electron-vite dev controls the Electron app over Node IPC so it can
    // hot-restart the main process. On macOS, Ctrl+C can stop that parent process
    // without terminating the app window, so in dev we quit explicitly when the
    // supervising IPC channel disconnects instead of leaving a stray Electron app.
    process.once('disconnect', () => {
        requestDevParentShutdown();
    });
}
export function installDevParentWatchdog(isDev) {
    if (!isDev) {
        return;
    }
    const initialParentPid = process.ppid;
    if (!Number.isInteger(initialParentPid) || initialParentPid <= 1) {
        return;
    }
    const timer = setInterval(() => {
        const parentPidChanged = process.ppid !== initialParentPid;
        let parentMissing = false;
        try {
            process.kill(initialParentPid, 0);
        }
        catch (error) {
            if (error &&
                typeof error === 'object' &&
                'code' in error &&
                error.code === 'ESRCH') {
                parentMissing = true;
            }
            else {
                throw error;
            }
        }
        if (parentPidChanged || parentMissing) {
            clearInterval(timer);
            // Why: electron-vite's dev runner starts Electron with plain spawn() and
            // inherited stdio, not an IPC channel. On macOS that means Ctrl+C can end
            // the dev runner while leaving Orca open. Watching the original parent PID
            // keeps dev shutdown coupled to the terminal session without affecting the
            // packaged app, which is not supervised by electron-vite.
            requestDevParentShutdown();
        }
    }, 1000);
    timer.unref();
}
export function enableMainProcessGpuFeatures() {
    app.commandLine.appendSwitch('enable-features', 'Vulkan,UseSkiaGraphite');
    app.commandLine.appendSwitch('enable-unsafe-webgpu');
}
