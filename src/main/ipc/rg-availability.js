import { wslAwareSpawn } from '../git/runner';
import { parseWslPath } from '../wsl';
// Why: when rg is not installed, spawn('rg', ...) emits both 'error' and
// 'close' events but their ordering is non-deterministic across Node versions
// and platforms. If 'close' fires first the handler resolves with empty
// results before the 'error' handler can trigger the git-grep fallback.
// Checking rg availability once upfront (cached) avoids the race entirely.
// Why: separate caches for native Windows and each WSL distro — rg may be
// installed in one environment but not the other, and different distros
// may have different packages installed.
let rgNativeCache = null;
const rgWslCache = new Map();
export function checkRgAvailable(searchPath) {
    const wslInfo = searchPath ? parseWslPath(searchPath) : null;
    const distro = wslInfo?.distro;
    if (distro) {
        const cached = rgWslCache.get(distro);
        if (cached !== undefined) {
            return Promise.resolve(cached);
        }
    }
    else if (rgNativeCache !== null) {
        return Promise.resolve(rgNativeCache);
    }
    return new Promise((resolve) => {
        // Why: pass cwd so wslAwareSpawn routes through wsl.exe when the search
        // path is inside a WSL filesystem. This checks whether rg is available
        // inside the WSL distro rather than on the Windows PATH.
        const child = wslAwareSpawn('rg', ['--version'], {
            ...(searchPath ? { cwd: searchPath } : {}),
            stdio: 'ignore'
        });
        child.once('error', () => {
            if (distro) {
                rgWslCache.set(distro, false);
            }
            else {
                rgNativeCache = false;
            }
            resolve(false);
        });
        child.once('close', (code) => {
            const alreadyCached = distro ? rgWslCache.has(distro) : rgNativeCache !== null;
            if (alreadyCached) {
                // error handler already resolved
                return;
            }
            const available = code === 0;
            if (distro) {
                rgWslCache.set(distro, available);
            }
            else {
                rgNativeCache = available;
            }
            resolve(available);
        });
    });
}
