import { ipcMain } from 'electron';
import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import { TUI_AGENT_CONFIG } from '../../shared/tui-agent-config';
const execFileAsync = promisify(execFile);
// Why: cache the result so repeated Landing mounts don't re-spawn processes.
// The check only runs once per app session — relaunch to re-check.
let cached = null;
/** @internal - tests need a clean preflight cache between cases. */
export function _resetPreflightCache() {
    cached = null;
}
async function isCommandAvailable(command) {
    try {
        await execFileAsync(command, ['--version']);
        return true;
    }
    catch {
        return false;
    }
}
// Why: `which`/`where` is faster than spawning the agent binary itself and avoids
// triggering any agent-specific startup side-effects. This gives a reliable
// PATH-based check without requiring `--version` support from each agent.
async function isCommandOnPath(command) {
    const finder = process.platform === 'win32' ? 'where' : 'which';
    try {
        const { stdout } = await execFileAsync(finder, [command], { encoding: 'utf-8' });
        return stdout
            .split(/\r?\n/)
            .map((line) => line.trim())
            .some((line) => path.isAbsolute(line));
    }
    catch {
        return false;
    }
}
const KNOWN_AGENT_COMMANDS = Object.entries(TUI_AGENT_CONFIG).map(([id, config]) => ({
    id,
    cmd: config.detectCmd
}));
export async function detectInstalledAgents() {
    const checks = await Promise.all(KNOWN_AGENT_COMMANDS.map(async ({ id, cmd }) => ({
        id,
        installed: await isCommandOnPath(cmd)
    })));
    return checks.filter((c) => c.installed).map((c) => c.id);
}
async function isGhAuthenticated() {
    try {
        await execFileAsync('gh', ['auth', 'status'], {
            encoding: 'utf-8'
        });
        // Why: for plain-text `gh auth status`, exit 0 means gh did not detect any
        // authentication issues for the checked hosts/accounts.
        return true;
    }
    catch (error) {
        // Why: some environments may surface partial command output on the thrown
        // error object. Keep a compatibility fallback so we avoid a false auth
        // warning if success markers are present despite a non-zero result.
        const stdout = error.stdout ?? '';
        const stderr = error.stderr ?? '';
        const output = `${stdout}\n${stderr}`;
        return output.includes('Logged in') || output.includes('Active account: true');
    }
}
export async function runPreflightCheck(force = false) {
    if (cached && !force) {
        return cached;
    }
    const [gitInstalled, ghInstalled] = await Promise.all([
        isCommandAvailable('git'),
        isCommandAvailable('gh')
    ]);
    const ghAuthenticated = ghInstalled ? await isGhAuthenticated() : false;
    cached = {
        git: { installed: gitInstalled },
        gh: { installed: ghInstalled, authenticated: ghAuthenticated }
    };
    return cached;
}
export function registerPreflightHandlers() {
    ipcMain.handle('preflight:check', async (_event, args) => {
        return runPreflightCheck(args?.force);
    });
    ipcMain.handle('preflight:detectAgents', async () => {
        return detectInstalledAgents();
    });
}
