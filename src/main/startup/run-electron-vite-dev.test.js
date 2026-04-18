import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
const processesToCleanUp = new Set();
function sleep(ms) {
    return new Promise((resolvePromise) => {
        setTimeout(resolvePromise, ms);
    });
}
function processExists(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (error) {
        const code = error && typeof error === 'object' && 'code' in error ? error.code : null;
        if (code === 'ESRCH') {
            return false;
        }
        throw error;
    }
}
async function waitFor(predicate, timeoutMs = 5000) {
    const start = Date.now();
    while (!predicate()) {
        if (Date.now() - start > timeoutMs) {
            throw new Error('Timed out waiting for condition');
        }
        await sleep(50);
    }
}
describe('run-electron-vite-dev', () => {
    afterEach(() => {
        for (const pid of processesToCleanUp) {
            try {
                process.kill(pid, 'SIGKILL');
            }
            catch (error) {
                const code = error && typeof error === 'object' && 'code' in error ? error.code : null;
                if (code !== 'ESRCH') {
                    throw error;
                }
            }
        }
        processesToCleanUp.clear();
    });
    it.skipIf(process.platform === 'win32')('kills the descendant process tree on SIGINT', async () => {
        const tempDir = mkdtempSync(join(tmpdir(), 'orca-dev-wrapper-'));
        const pidFile = join(tempDir, 'grandchild.pid');
        const wrapperPath = resolve('config/scripts/run-electron-vite-dev.mjs');
        const fakeCliPath = resolve('src/main/startup/__fixtures__/fake-electron-vite-dev-cli.mjs');
        const wrapper = spawn(process.execPath, [wrapperPath], {
            cwd: resolve('.'),
            env: {
                ...process.env,
                ORCA_ELECTRON_VITE_CLI: fakeCliPath,
                ORCA_DEV_WRAPPER_TEST_PID_FILE: pidFile
            },
            stdio: 'ignore'
        });
        expect(wrapper.pid).toBeTypeOf('number');
        processesToCleanUp.add(wrapper.pid);
        await waitFor(() => {
            try {
                return readFileSync(pidFile, 'utf8').trim().length > 0;
            }
            catch {
                return false;
            }
        });
        const grandchildPid = Number.parseInt(readFileSync(pidFile, 'utf8').trim(), 10);
        expect(Number.isFinite(grandchildPid)).toBe(true);
        processesToCleanUp.add(grandchildPid);
        expect(processExists(grandchildPid)).toBe(true);
        const exitPromise = new Promise((resolveExit) => {
            wrapper.on('exit', (code) => {
                resolveExit(code);
            });
        });
        wrapper.kill('SIGINT');
        const exitCode = await exitPromise;
        expect(exitCode).toBe(130);
        await waitFor(() => !processExists(grandchildPid));
        processesToCleanUp.delete(grandchildPid);
        processesToCleanUp.delete(wrapper.pid);
    });
});
