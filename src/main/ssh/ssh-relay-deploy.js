import { join } from 'path';
import { existsSync } from 'fs';
import { app } from 'electron';
import { RELAY_VERSION, RELAY_REMOTE_DIR, parseUnameToRelayPlatform } from './relay-protocol';
import { uploadDirectory, waitForSentinel, execCommand, resolveRemoteNodePath } from './ssh-relay-deploy-helpers';
import { shellEscape } from './ssh-connection-utils';
// Why: individual exec commands have 30s timeouts, but the full deploy
// pipeline (detect platform → check existing → upload → npm install →
// launch) has no overall bound. A hanging `npm install` or slow SFTP
// upload could block the connection indefinitely.
const RELAY_DEPLOY_TIMEOUT_MS = 120_000;
/**
 * Deploy the relay to the remote host and launch it.
 *
 * Steps:
 * 1. Detect remote OS/arch via `uname -sm`
 * 2. Check if correct relay version is already deployed
 * 3. If not, SCP the relay package
 * 4. Launch relay via exec channel
 * 5. Wait for ORCA-RELAY sentinel on stdout
 * 6. Return the transport (relay's stdin/stdout) for multiplexer use
 */
export async function deployAndLaunchRelay(conn, onProgress) {
    let timeoutHandle;
    const timeoutPromise = new Promise((_resolve, reject) => {
        timeoutHandle = setTimeout(() => {
            reject(new Error(`Relay deployment timed out after ${RELAY_DEPLOY_TIMEOUT_MS / 1000}s`));
        }, RELAY_DEPLOY_TIMEOUT_MS);
    });
    try {
        return await Promise.race([deployAndLaunchRelayInner(conn, onProgress), timeoutPromise]);
    }
    finally {
        clearTimeout(timeoutHandle);
    }
}
async function deployAndLaunchRelayInner(conn, onProgress) {
    onProgress?.('Detecting remote platform...');
    console.log('[ssh-relay] Detecting remote platform...');
    const platform = await detectRemotePlatform(conn);
    if (!platform) {
        throw new Error('Unsupported remote platform. Orca relay supports: linux-x64, linux-arm64, darwin-x64, darwin-arm64.');
    }
    console.log(`[ssh-relay] Platform: ${platform}`);
    // Why: SFTP does not expand `~`, so we must resolve the remote home directory
    // explicitly. `echo $HOME` over exec gives us the absolute path.
    const remoteHome = (await execCommand(conn, 'echo $HOME')).trim();
    // Why: we only interpolate $HOME into single-quoted shell strings later, so
    // this validation only needs to reject obviously unsafe control characters.
    // Allow spaces and non-ASCII so valid home directories are not rejected.
    // oxlint-disable-next-line no-control-regex
    if (!remoteHome || !remoteHome.startsWith('/') || /[\u0000\r\n]/.test(remoteHome)) {
        throw new Error(`Remote $HOME is not a valid path: ${remoteHome.slice(0, 100)}`);
    }
    const remoteRelayDir = `${remoteHome}/${RELAY_REMOTE_DIR}/relay-v${RELAY_VERSION}`;
    console.log(`[ssh-relay] Remote dir: ${remoteRelayDir}`);
    onProgress?.('Checking existing relay...');
    const localRelayDir = getLocalRelayPath(platform);
    const alreadyDeployed = await checkRelayExists(conn, remoteRelayDir, localRelayDir);
    console.log(`[ssh-relay] Already deployed: ${alreadyDeployed}`);
    if (!alreadyDeployed) {
        onProgress?.('Uploading relay...');
        console.log('[ssh-relay] Uploading relay...');
        await uploadRelay(conn, platform, remoteRelayDir);
        console.log('[ssh-relay] Upload complete');
        onProgress?.('Installing native dependencies...');
        console.log('[ssh-relay] Installing node-pty...');
        await installNativeDeps(conn, remoteRelayDir);
        console.log('[ssh-relay] Native deps installed');
    }
    onProgress?.('Starting relay...');
    console.log('[ssh-relay] Launching relay...');
    const transport = await launchRelay(conn, remoteRelayDir);
    console.log('[ssh-relay] Relay started successfully');
    return { transport, platform };
}
async function detectRemotePlatform(conn) {
    const output = await execCommand(conn, 'uname -sm');
    const parts = output.trim().split(/\s+/);
    if (parts.length < 2) {
        return null;
    }
    return parseUnameToRelayPlatform(parts[0], parts[1]);
}
async function checkRelayExists(conn, remoteDir, localRelayDir) {
    try {
        const output = await execCommand(conn, `test -f ${shellEscape(`${remoteDir}/relay.js`)} && echo OK || echo MISSING`);
        if (output.trim() !== 'OK') {
            return false;
        }
        // Why: compare against the local .version file content (which includes a
        // content hash) so any code change triggers re-deploy, even without bumping
        // RELAY_VERSION. Falls back to the bare RELAY_VERSION for safety.
        let expectedVersion = RELAY_VERSION;
        if (localRelayDir) {
            try {
                const { readFileSync } = await import('fs');
                expectedVersion = readFileSync(join(localRelayDir, '.version'), 'utf-8').trim();
            }
            catch {
                /* fall back to RELAY_VERSION */
            }
        }
        const versionOutput = await execCommand(conn, `cat ${shellEscape(`${remoteDir}/.version`)} 2>/dev/null || echo MISSING`);
        return versionOutput.trim() === expectedVersion;
    }
    catch {
        return false;
    }
}
async function uploadRelay(conn, platform, remoteDir) {
    const localRelayDir = getLocalRelayPath(platform);
    if (!localRelayDir || !existsSync(localRelayDir)) {
        throw new Error(`Relay package for ${platform} not found at ${localRelayDir}. ` +
            `This may be a packaging issue — try reinstalling Orca.`);
    }
    // Create remote directory
    await execCommand(conn, `mkdir -p ${shellEscape(remoteDir)}`);
    // Upload via SFTP
    const sftp = await conn.sftp();
    try {
        await uploadDirectory(sftp, localRelayDir, remoteDir);
    }
    finally {
        sftp.end();
    }
    // Make the node binary executable
    await execCommand(conn, `chmod +x ${shellEscape(`${remoteDir}/node`)} 2>/dev/null; true`);
    // Why: version marker includes a content hash so code changes trigger
    // re-deploy even without bumping RELAY_VERSION. Read from the local build
    // output so the remote marker matches exactly what checkRelayExists expects.
    // Why: we write the version file via SFTP instead of a shell command to
    // avoid shell injection — the version string could contain characters
    // that break or escape single-quoted shell interpolation.
    let versionString = RELAY_VERSION;
    const localVersionFile = join(localRelayDir, '.version');
    if (existsSync(localVersionFile)) {
        const { readFileSync } = await import('fs');
        versionString = readFileSync(localVersionFile, 'utf-8').trim();
    }
    const versionSftp = await conn.sftp();
    try {
        await new Promise((resolve, reject) => {
            const ws = versionSftp.createWriteStream(`${remoteDir}/.version`);
            ws.on('close', resolve);
            ws.on('error', reject);
            ws.end(versionString);
        });
    }
    finally {
        versionSftp.end();
    }
}
// Why: node-pty is a native addon that can't be bundled by esbuild. It must
// be compiled on the remote host against its Node.js version and OS. We run
// `npm init -y && npm install node-pty` in the relay directory so
// `require('node-pty')` resolves to the local node_modules.
async function installNativeDeps(conn, remoteDir) {
    const nodePath = await resolveRemoteNodePath(conn);
    // Why: node's bin directory must be in PATH for npm's child processes.
    // npm install runs node-pty's prebuild script (`node scripts/prebuild.js`)
    // which spawns `node` as a child — if node isn't in PATH, that child
    // fails with exit 127 even though we invoked npm via its full path.
    const nodeBinDir = nodePath.replace(/\/node$/, '');
    const escapedDir = shellEscape(remoteDir);
    const escapedBinDir = shellEscape(nodeBinDir);
    try {
        await execCommand(conn, `export PATH=${escapedBinDir}:$PATH && cd ${escapedDir} && npm init -y --silent 2>/dev/null && npm install node-pty 2>&1`);
        // Why: SFTP uploads preserve file content but not Unix execute bits.
        // node-pty ships a prebuilt `spawn-helper` binary that must be executable
        // for posix_spawnp to fork the PTY process.
        await execCommand(conn, `find ${shellEscape(`${remoteDir}/node_modules/node-pty/prebuilds`)} -name spawn-helper -exec chmod +x {} + 2>/dev/null; true`);
    }
    catch (err) {
        // Why: node-pty install can fail if build tools (python, make, g++) are
        // missing on the remote. Log the error but don't block relay startup —
        // the relay will degrade gracefully (pty.spawn returns an error).
        console.warn('[ssh-relay] Failed to install node-pty:', err.message);
    }
}
function getLocalRelayPath(platform) {
    if (process.env.ORCA_RELAY_PATH) {
        const override = join(process.env.ORCA_RELAY_PATH, platform);
        if (existsSync(override)) {
            return override;
        }
    }
    // Production: bundled alongside the app
    const prodPath = join(app.getAppPath(), 'resources', 'relay', platform);
    if (existsSync(prodPath)) {
        return prodPath;
    }
    // Development: built by `pnpm build:relay` into out/relay/{platform}/
    const devPath = join(app.getAppPath(), 'out', 'relay', platform);
    if (existsSync(devPath)) {
        return devPath;
    }
    return null;
}
async function launchRelay(conn, remoteDir) {
    // Why: Phase 1 of the plan requires Node.js on the remote. We use the
    // system `node` rather than bundling a node binary, keeping the relay
    // package small (~100KB JS vs ~60MB with embedded node).
    // Non-login SSH shells may not have node in PATH, so we source the
    // user's profile to pick up nvm/fnm/brew PATH entries.
    const nodePath = await resolveRemoteNodePath(conn);
    // Why: both remoteDir and nodePath come from the remote host and could
    // contain shell metacharacters. Single-quote escaping prevents injection.
    const channel = await conn.exec(`cd ${shellEscape(remoteDir)} && ${shellEscape(nodePath)} relay.js --grace-time 60`);
    return waitForSentinel(channel);
}
