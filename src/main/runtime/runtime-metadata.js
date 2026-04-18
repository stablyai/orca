import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs';
import { execFileSync } from 'child_process';
import { dirname } from 'path';
import { getRuntimeMetadataPath } from '../../shared/runtime-bootstrap';
let cachedWindowsUserSid;
export function writeRuntimeMetadata(userDataPath, metadata) {
    const metadataPath = getRuntimeMetadataPath(userDataPath);
    writeMetadataFile(metadataPath, metadata);
}
export function readRuntimeMetadata(userDataPath) {
    const metadataPath = getRuntimeMetadataPath(userDataPath);
    if (!existsSync(metadataPath)) {
        return null;
    }
    return JSON.parse(readFileSync(metadataPath, 'utf-8'));
}
export function clearRuntimeMetadata(userDataPath) {
    rmSync(getRuntimeMetadataPath(userDataPath), { force: true });
}
function writeMetadataFile(path, metadata) {
    const dir = dirname(path);
    if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    hardenRuntimePath(dir, { isDirectory: true, platform: process.platform });
    const tmpFile = `${path}.tmp`;
    writeFileSync(tmpFile, JSON.stringify(metadata, null, 2), {
        encoding: 'utf-8',
        mode: 0o600
    });
    hardenRuntimePath(tmpFile, { isDirectory: false, platform: process.platform });
    renameSync(tmpFile, path);
    // Why: runtime bootstrap files carry auth material that lets the local CLI
    // attach to a live Orca runtime. The published file must stay scoped to
    // the current user.
    hardenRuntimePath(path, { isDirectory: false, platform: process.platform });
}
function hardenRuntimePath(targetPath, options) {
    if (options.platform === 'win32') {
        bestEffortRestrictWindowsPath(targetPath);
        return;
    }
    chmodSync(targetPath, options.isDirectory ? 0o700 : 0o600);
}
function bestEffortRestrictWindowsPath(targetPath) {
    const currentUserSid = getCurrentWindowsUserSid();
    if (!currentUserSid) {
        return;
    }
    try {
        execFileSync('icacls', [
            targetPath,
            '/inheritance:r',
            '/grant:r',
            `*${currentUserSid}:(F)`,
            '*S-1-5-18:(F)',
            '*S-1-5-32-544:(F)'
        ], {
            stdio: 'ignore',
            windowsHide: true,
            timeout: 5000
        });
    }
    catch {
        // Why: runtime metadata hardening should not prevent Orca from starting on
        // Windows machines where icacls is unavailable or locked down differently.
    }
}
function getCurrentWindowsUserSid() {
    if (cachedWindowsUserSid !== undefined) {
        return cachedWindowsUserSid;
    }
    try {
        const output = execFileSync('whoami', ['/user', '/fo', 'csv', '/nh'], {
            encoding: 'utf-8',
            stdio: ['ignore', 'pipe', 'ignore'],
            windowsHide: true,
            timeout: 5000
        }).trim();
        const columns = parseCsvLine(output);
        cachedWindowsUserSid = columns[1] ?? null;
    }
    catch {
        cachedWindowsUserSid = null;
    }
    return cachedWindowsUserSid;
}
function parseCsvLine(line) {
    return line.split(/","/).map((part) => part.replace(/^"/, '').replace(/"$/, ''));
}
