import { fork } from 'child_process';
const READY_TIMEOUT_MS = 10_000;
export function createProductionLauncher(opts) {
    return async (socketPath, tokenPath) => {
        const entryPath = opts.getDaemonEntryPath();
        const child = fork(entryPath, ['--socket', socketPath, '--token', tokenPath], {
            stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
            detached: true,
            env: { ...process.env },
            ...(process.platform === 'win32' ? { windowsHide: true } : {})
        });
        await waitForReady(child);
        // Unref so the Electron process can exit without waiting for the daemon
        child.unref();
        child.disconnect();
        return {
            shutdown: () => shutdownChild(child)
        };
    };
}
function waitForReady(child) {
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            child.kill('SIGTERM');
            reject(new Error('Daemon failed to signal readiness within timeout'));
        }, READY_TIMEOUT_MS);
        child.on('message', (msg) => {
            if (msg && typeof msg === 'object' && msg.type === 'ready') {
                clearTimeout(timeout);
                resolve();
            }
        });
        child.on('error', (err) => {
            clearTimeout(timeout);
            reject(new Error(`Daemon process error: ${err.message}`));
        });
        child.on('exit', (code) => {
            clearTimeout(timeout);
            reject(new Error(`Daemon process exited prematurely with code ${code}`));
        });
    });
}
function shutdownChild(child) {
    return new Promise((resolve) => {
        if (child.killed) {
            resolve();
            return;
        }
        const timeout = setTimeout(() => {
            child.kill('SIGKILL');
            resolve();
        }, 5000);
        child.once('exit', () => {
            clearTimeout(timeout);
            resolve();
        });
        child.kill('SIGTERM');
    });
}
