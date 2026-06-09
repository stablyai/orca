import { join } from 'path'
/* eslint-disable max-lines -- Why: the relay-deploy module owns one cohesive
   contract — version detection, install-locked deploy, native-deps probe,
   relay launch, and GC — and splitting risks drift between the install
   sequence and the GC's live-socket invariant. */
import { existsSync } from 'fs'
import { app } from 'electron'
import type { SshConnection } from './ssh-connection'
import type { RelayPlatform } from './relay-protocol'
import type { MultiplexerTransport } from './ssh-channel-multiplexer'
import { uploadDirectory, waitForSentinel, execCommand } from './ssh-relay-deploy-helpers'
import { resolveRemoteNodePath } from './ssh-remote-node-resolution'
import {
  readLocalFullVersion,
  computeRemoteRelayDir,
  isRelayAlreadyInstalled,
  acquireInstallLock,
  finalizeInstall,
  abandonInstall,
  gcOldRelayVersions
} from './ssh-relay-versioned-install'
import { shellEscape } from './ssh-connection-utils'
import {
  commandWithNodePath,
  makeRemoteDirectoryCommand,
  makeRemoteExecutableCommand,
  readRemoteHomeCommand,
  removeRemoteFileCommand
} from './ssh-remote-commands'
import {
  isWindowsRemoteHost,
  joinRemotePath,
  normalizeRemoteHome,
  validateRemoteHome,
  type RemoteHostPlatform
} from './ssh-remote-platform'
import { detectRemoteHostPlatform } from './ssh-remote-platform-detection'
import { powerShellCommand, powerShellLiteral } from './ssh-remote-powershell'
import { relaySocketNameForInstanceId } from './ssh-relay-instance-id'
import {
  isWindowsRelayPipePath,
  relayEndpointForHost,
  relayHookEndpointDirForHost,
  windowsActivePipeMarkerPath,
  windowsRelayFallbackSocketName
} from './ssh-relay-endpoints'
import {
  DEFAULT_SSH_RELAY_GRACE_PERIOD_SECONDS,
  MAX_SSH_RELAY_GRACE_PERIOD_SECONDS,
  MIN_SSH_RELAY_GRACE_PERIOD_SECONDS
} from '../../shared/ssh-types'

export type RelayDeployResult = {
  transport: MultiplexerTransport
  platform: RelayPlatform
  hostPlatform?: RemoteHostPlatform
  remoteHome?: string
  remoteRelayDir?: string
  nodePath?: string
  sockPath?: string
}

// Why: individual exec commands have 30s timeouts, but the full deploy
// pipeline (detect platform → check existing → upload → npm install →
// launch) has no overall bound. A hanging `npm install` or slow SFTP
// upload could block the connection indefinitely.
const RELAY_DEPLOY_TIMEOUT_MS = 120_000

function execHostCommand(
  conn: SshConnection,
  hostPlatform: RemoteHostPlatform,
  command: string
): Promise<string> {
  return execCommand(conn, command, { wrapCommand: !isWindowsRemoteHost(hostPlatform) })
}

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
export async function deployAndLaunchRelay(
  conn: SshConnection,
  onProgress?: (status: string) => void,
  graceTimeSeconds?: number,
  relayInstanceId?: string
): Promise<RelayDeployResult> {
  let timeoutHandle: ReturnType<typeof setTimeout>
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeoutHandle = setTimeout(() => {
      reject(new Error(`Relay deployment timed out after ${RELAY_DEPLOY_TIMEOUT_MS / 1000}s`))
    }, RELAY_DEPLOY_TIMEOUT_MS)
  })

  try {
    return await Promise.race([
      deployAndLaunchRelayInner(conn, onProgress, graceTimeSeconds, relayInstanceId),
      timeoutPromise
    ])
  } finally {
    clearTimeout(timeoutHandle!)
  }
}

async function deployAndLaunchRelayInner(
  conn: SshConnection,
  onProgress?: (status: string) => void,
  graceTimeSeconds?: number,
  relayInstanceId?: string
): Promise<RelayDeployResult> {
  onProgress?.('Detecting remote platform...')
  console.log('[ssh-relay] Detecting remote platform...')
  const hostPlatform = await detectRemoteHostPlatform(conn)
  if (!hostPlatform) {
    throw new Error(
      'Unsupported remote platform. Orca relay supports: linux-x64, linux-arm64, darwin-x64, darwin-arm64, win32-x64, win32-arm64.'
    )
  }
  const platform = hostPlatform.relayPlatform
  console.log(`[ssh-relay] Platform: ${platform}`)

  const localRelayDir = getLocalRelayPath(platform)
  if (!localRelayDir) {
    throw new Error(
      `Relay package for ${platform} not found locally. ` +
        `This may be a packaging issue — try reinstalling Orca.`
    )
  }
  // Why: read the content-hashed full version from the local build's .version
  // file. Used as both the remote dir name and the wire-handshake version.
  // Throws on missing/empty rather than silently falling back — see
  // docs/ssh-relay-versioned-install-dirs.md "Data Flow: Upstream Error".
  const fullVersion = readLocalFullVersion(localRelayDir)

  // Why: SFTP does not expand `~`, so we must resolve the remote home
  // explicitly with the host's native shell and normalize it before use.
  const remoteHome = normalizeRemoteHome(
    await execHostCommand(conn, hostPlatform, readRemoteHomeCommand(hostPlatform)),
    hostPlatform
  )
  // Why: we only interpolate $HOME into single-quoted shell strings later, so
  // this validation only needs to reject obviously unsafe control characters.
  // Allow spaces and non-ASCII so valid home directories are not rejected.
  if (!validateRemoteHome(remoteHome, hostPlatform)) {
    throw new Error(`Remote home is not a valid path: ${remoteHome.slice(0, 100)}`)
  }
  const remoteRelayDir = computeRemoteRelayDir(remoteHome, fullVersion, hostPlatform.pathFlavor)
  console.log(`[ssh-relay] Remote dir: ${remoteRelayDir}`)

  onProgress?.('Checking existing relay...')
  const alreadyInstalled = await isRelayAlreadyInstalled(conn, remoteRelayDir, hostPlatform)
  console.log(`[ssh-relay] Already installed at ${fullVersion}: ${alreadyInstalled}`)
  const nodePath = await resolveRemoteNodePath(conn, hostPlatform)

  if (alreadyInstalled) {
    await repairInstalledNativeDeps(conn, remoteRelayDir, platform, hostPlatform, nodePath)
  } else {
    // Why: serialize concurrent first-installs of the same version against
    // each other via an atomic mkdir lock. The losing caller polls and either
    // re-checks `alreadyInstalled` (now true) or steals a stale lock.
    await acquireInstallLock(conn, remoteRelayDir, hostPlatform)
    try {
      // Re-probe after acquiring the lock — a sibling installer may have
      // finished while we were waiting.
      if (!(await isRelayAlreadyInstalled(conn, remoteRelayDir, hostPlatform))) {
        onProgress?.('Uploading relay...')
        console.log('[ssh-relay] Uploading relay...')
        await uploadRelay(conn, platform, remoteRelayDir, fullVersion, hostPlatform)
        console.log('[ssh-relay] Upload complete')

        onProgress?.('Installing native dependencies...')
        console.log('[ssh-relay] Installing native dependencies...')
        await installNativeDeps(conn, remoteRelayDir, platform, hostPlatform, nodePath)
        console.log('[ssh-relay] Native deps installed')

        // Why: write `.install-complete` BEFORE releasing the lock so a
        // sibling never observes the dir as "complete but locked", which
        // would lead GC to skip a recoverable dir indefinitely.
        await finalizeInstall(conn, remoteRelayDir, hostPlatform)
      } else {
        await abandonInstall(conn, remoteRelayDir, hostPlatform)
      }
    } catch (err) {
      // Why: leave a partial install dir in place (no `.install-complete`)
      // so the next deploy detects the partial and re-runs upload + install.
      // Just release the lock so a concurrent caller can retry.
      await abandonInstall(conn, remoteRelayDir, hostPlatform)
      throw err
    }
  }

  onProgress?.('Starting relay...')
  console.log('[ssh-relay] Launching relay...')
  const launched = await launchRelay(
    conn,
    remoteRelayDir,
    hostPlatform,
    nodePath,
    graceTimeSeconds,
    relayInstanceId
  )
  console.log('[ssh-relay] Relay started successfully')

  // Why: best-effort cleanup of unreferenced sibling version dirs. Errors
  // are logged inside gcOldRelayVersions and never propagate, so a GC failure
  // can never block the user from connecting.
  void gcOldRelayVersions(conn, remoteHome, remoteRelayDir, hostPlatform, {
    windowsNodePath: launched.nodePath,
    windowsSockNames: [relaySocketNameForInstanceId(relayInstanceId)]
  }).catch(() => {})

  return {
    transport: launched.transport,
    platform,
    hostPlatform,
    remoteHome,
    remoteRelayDir,
    nodePath: launched.nodePath,
    sockPath: launched.sockPath
  }
}

async function uploadRelay(
  conn: SshConnection,
  platform: RelayPlatform,
  remoteDir: string,
  fullVersion: string,
  hostPlatform: RemoteHostPlatform
): Promise<void> {
  const localRelayDir = getLocalRelayPath(platform)
  if (!localRelayDir || !existsSync(localRelayDir)) {
    throw new Error(
      `Relay package for ${platform} not found. Searched: ${getLocalRelayCandidates(platform).join(', ')}. ` +
        `This may be a packaging issue — try reinstalling Orca.`
    )
  }

  // Create remote directory
  await execHostCommand(conn, hostPlatform, makeRemoteDirectoryCommand(hostPlatform, remoteDir))

  await uploadDirectoryForConnection(conn, localRelayDir, remoteDir, hostPlatform)

  // Make the node binary executable
  if (!isWindowsRemoteHost(hostPlatform)) {
    await execHostCommand(
      conn,
      hostPlatform,
      makeRemoteExecutableCommand(hostPlatform, joinRemotePath(hostPlatform, remoteDir, 'node'))
    )
  }

  // Why: write `.version` via SFTP rather than shell to avoid quoting issues
  // with content-hashed version strings. The remote daemon reads this same
  // file on startup so the wire-handshake validates against it.
  await writeRemoteFile(
    conn,
    hostPlatform,
    joinRemotePath(hostPlatform, remoteDir, '.version'),
    fullVersion
  )
}

async function uploadDirectoryForConnection(
  conn: SshConnection,
  localRelayDir: string,
  remoteDir: string,
  hostPlatform: RemoteHostPlatform
): Promise<void> {
  if (typeof conn.uploadDirectory === 'function') {
    await conn.uploadDirectory(localRelayDir, remoteDir, { hostPlatform })
    return
  }

  const sftp = await conn.sftp()
  try {
    await uploadDirectory(sftp, localRelayDir, remoteDir)
  } finally {
    sftp.end()
  }
}

async function writeRemoteFile(
  conn: SshConnection,
  hostPlatform: RemoteHostPlatform,
  remotePath: string,
  contents: string
): Promise<void> {
  if (typeof conn.writeFile === 'function') {
    await conn.writeFile(remotePath, contents, { hostPlatform })
    return
  }

  const sftp = await conn.sftp()
  try {
    await new Promise<void>((resolve, reject) => {
      const ws = sftp.createWriteStream(remotePath)
      // .once: a session 'error' arriving after we've already resolved/rejected
      // would otherwise become an unhandled error and crash main.
      sftp.once('error', reject)
      ws.once('close', resolve)
      ws.once('error', reject)
      ws.end(contents)
    })
  } finally {
    sftp.end()
  }
}

const RELAY_NATIVE_DEPS = {
  'node-pty': '1.1.0',
  '@parcel/watcher': '2.5.6'
} as const

async function hasRequiredNativeDeps(
  conn: SshConnection,
  remoteDir: string,
  hostPlatform: RemoteHostPlatform,
  nodePath: string
): Promise<boolean> {
  const escapedNode = shellEscape(nodePath)
  try {
    const command = isWindowsRemoteHost(hostPlatform)
      ? commandWithNodePath(
          hostPlatform,
          nodePath,
          remoteDir,
          `try { & ${powerShellLiteral(nodePath)} -e ${powerShellLiteral('require.resolve("node-pty"); require.resolve("@parcel/watcher"); console.log("ORCA-NATIVE-DEPS-OK")')} } catch { 'MISSING' }`
        )
      : commandWithNodePath(
          hostPlatform,
          nodePath,
          remoteDir,
          `(${escapedNode} -e 'require.resolve("node-pty"); require.resolve("@parcel/watcher"); console.log("ORCA-NATIVE-DEPS-OK")' 2>/dev/null || echo MISSING)`
        )
    const probe = await execHostCommand(conn, hostPlatform, command)
    return probe.includes('ORCA-NATIVE-DEPS-OK')
  } catch {
    return false
  }
}

async function repairInstalledNativeDeps(
  conn: SshConnection,
  remoteDir: string,
  platform: RelayPlatform,
  hostPlatform: RemoteHostPlatform,
  nodePath: string
): Promise<void> {
  if (await hasRequiredNativeDeps(conn, remoteDir, hostPlatform, nodePath)) {
    return
  }

  console.warn(`[ssh-relay] Repairing missing native deps at ${remoteDir}`)
  await acquireInstallLock(conn, remoteDir, hostPlatform)
  try {
    // Why: older complete relay dirs were created before @parcel/watcher was
    // installed. Re-probe under the lock so only one reconnect mutates the dir.
    if (!(await hasRequiredNativeDeps(conn, remoteDir, hostPlatform, nodePath))) {
      await installNativeDeps(conn, remoteDir, platform, hostPlatform, nodePath)
      await finalizeInstall(conn, remoteDir, hostPlatform)
    } else {
      await abandonInstall(conn, remoteDir, hostPlatform)
    }
  } catch (err) {
    await abandonInstall(conn, remoteDir, hostPlatform)
    throw err
  }
}

// Why: node-pty and @parcel/watcher are native addons that can't be bundled by
// esbuild. They must be installed on the remote host against its Node.js version
// and OS so dynamic imports/require calls resolve from the relay dir.
//
// TODO(#1693): VS Code ships per-platform tarballs with node-pty pre-built
// from CI and skips `npm install` on the remote entirely. That approach
// eliminates the whole class of bugs around npm/compiler/network failures
// on the remote. Worth doing once we're past the immediate fix.
async function installNativeDeps(
  conn: SshConnection,
  remoteDir: string,
  platform: RelayPlatform,
  hostPlatform: RemoteHostPlatform,
  nodePath: string
): Promise<void> {
  // Why: node's bin directory must be in PATH for npm's child processes.
  // npm install runs node-pty's prebuild script (`node scripts/prebuild.js`)
  // which spawns `node` as a child — if node isn't in PATH, that child
  // fails with exit 127 even though we invoked npm via its full path.
  const escapedNode = shellEscape(nodePath)

  // npm init -y rejects '+' in derived package names (content-hashed dir
  // names like relay-0.1.0+abc123). Bypass it with a fixed minimal
  // package.json. type:commonjs pins module resolution against Node default
  // flips or a remote ~/.npmrc setting type=module.
  const pkgJson = `${JSON.stringify({
    name: 'orca-relay',
    version: '1.0.0',
    private: true,
    type: 'commonjs',
    dependencies: RELAY_NATIVE_DEPS
  })}\n`
  await writeRemoteFile(
    conn,
    hostPlatform,
    joinRemotePath(hostPlatform, remoteDir, 'package.json'),
    pkgJson
  )

  try {
    const installArgs = Object.entries(RELAY_NATIVE_DEPS)
      .map(([dep, version]) => shellEscape(`${dep}@${version}`))
      .join(' ')
    const command = isWindowsRemoteHost(hostPlatform)
      ? commandWithNodePath(
          hostPlatform,
          nodePath,
          remoteDir,
          `npm install --omit=dev --no-audit --no-fund ${Object.entries(RELAY_NATIVE_DEPS)
            .map(([dep, version]) => powerShellLiteral(`${dep}@${version}`))
            .join(' ')}`
        )
      : commandWithNodePath(
          hostPlatform,
          nodePath,
          remoteDir,
          `npm install --omit=dev --no-audit --no-fund ${installArgs} 2>&1`
        )
    await execHostCommand(conn, hostPlatform, command)
  } catch (err) {
    // Don't write .install-complete on hard fail; reconnect retries on a
    // partial install. Greppable token so user bug reports paste something
    // searchable.
    const msg = (err as Error).message
    console.warn(
      `[ssh-relay][NATIVE-DEPS-INSTALL-FAIL] npm install native deps failed at ${remoteDir} (${platform}): ${msg}`
    )
    throw err
  }

  // SFTP doesn't preserve execute bits; node-pty's spawn-helper prebuild
  // must be +x for posix_spawnp.
  if (!isWindowsRemoteHost(hostPlatform)) {
    await execHostCommand(
      conn,
      hostPlatform,
      `find ${shellEscape(joinRemotePath(hostPlatform, remoteDir, 'node_modules/node-pty/prebuilds'))} -name spawn-helper -exec chmod +x {} + 2>/dev/null; true`
    )
  }

  // node -e require() catches unloadable installs (wrong arch, missing
  // prebuild, broken native binding) that test -d cannot. Stderr → file
  // so .bashrc noise can't pollute the sentinel match; preserved for the
  // [NPTY-MISSING] breadcrumb. MISSING is non-fatal by design — see
  // docs/ssh-relay-versioned-install-dirs.md (relay still serves
  // fs/git/preflight; only pty.spawn fails at runtime).
  const PROBE_OK = 'ORCA-NPTY-PROBE-OK'
  const stderrFile = joinRemotePath(hostPlatform, remoteDir, '.npty-probe.stderr')
  const escapedStderr = shellEscape(stderrFile)
  const probeCommand = isWindowsRemoteHost(hostPlatform)
    ? commandWithNodePath(
        hostPlatform,
        nodePath,
        remoteDir,
        `try { & ${powerShellLiteral(nodePath)} -e ${powerShellLiteral('require("node-pty"); console.log(process.argv[1])')} ${powerShellLiteral(PROBE_OK)}; if ($LASTEXITCODE -ne 0) { 'MISSING' } } catch { 'MISSING' }`
      )
    : commandWithNodePath(
        hostPlatform,
        nodePath,
        remoteDir,
        `(${escapedNode} -e 'require("node-pty"); console.log(process.argv[1])' ${shellEscape(PROBE_OK)} 2>${escapedStderr} || echo MISSING)`
      )
  const probeOutput = await execHostCommand(conn, hostPlatform, probeCommand)
  if (!probeOutput.includes(PROBE_OK)) {
    const remoteStderr = isWindowsRemoteHost(hostPlatform)
      ? ''
      : await execHostCommand(conn, hostPlatform, `cat ${escapedStderr} 2>/dev/null; true`).catch(
          () => ''
        )
    console.warn(
      `[ssh-relay][NPTY-MISSING] node-pty installed but require() failed at ${remoteDir} (${platform}). stdout=${probeOutput.trim().slice(-200)} stderr=${remoteStderr.trim().slice(-500)}`
    )
  }
  await execHostCommand(
    conn,
    hostPlatform,
    removeRemoteFileCommand(hostPlatform, stderrFile)
  ).catch(() => {})
}

function getLocalRelayPath(platform: RelayPlatform): string | null {
  for (const candidate of getLocalRelayCandidates(platform)) {
    if (existsSync(candidate)) {
      return candidate
    }
  }
  return null
}

export function getLocalRelayCandidates(platform: RelayPlatform): string[] {
  const candidates: string[] = []
  if (process.env.ORCA_RELAY_PATH) {
    candidates.push(join(process.env.ORCA_RELAY_PATH, platform))
  }

  // Why: electron-builder copies extraResources next to the app bundle, while
  // app.getAppPath() points at app.asar in packaged builds.
  if (process.resourcesPath) {
    candidates.push(join(process.resourcesPath, 'relay', platform))
    candidates.push(join(process.resourcesPath, 'app.asar.unpacked', 'out', 'relay', platform))
  }

  const appPath = app.getAppPath()
  candidates.push(
    join(appPath, 'resources', 'relay', platform),
    join(appPath, 'out', 'relay', platform)
  )

  return [...new Set(candidates)]
}

async function launchRelay(
  conn: SshConnection,
  remoteDir: string,
  hostPlatform: RemoteHostPlatform,
  nodePath: string,
  graceTimeSeconds?: number,
  relayInstanceId?: string
): Promise<{ transport: MultiplexerTransport; nodePath: string; sockPath: string }> {
  // Why: Phase 1 of the plan requires Node.js on the remote. We use the
  // system `node` rather than bundling a node binary, keeping the relay
  // package small (~100KB JS vs ~60MB with embedded node).
  // Non-login SSH shells may not have node in PATH, so we source the
  // user's profile to pick up nvm/fnm/brew PATH entries.
  // Why: graceTimeSeconds originates from user-editable SshTarget config.
  // Clamping to integer prevents shell injection if the type ever loosened.
  const requestedGraceTime = Math.floor(graceTimeSeconds ?? DEFAULT_SSH_RELAY_GRACE_PERIOD_SECONDS)
  const graceTime =
    requestedGraceTime === 0
      ? 0
      : Math.max(
          MIN_SSH_RELAY_GRACE_PERIOD_SECONDS,
          Math.min(MAX_SSH_RELAY_GRACE_PERIOD_SECONDS, requestedGraceTime)
        )
  const escapedDir = shellEscape(remoteDir)
  const escapedNode = shellEscape(nodePath)
  // Why: remoteRelayDir is shared by every Orca target for the same remote
  // account. Hashing the target ID into the socket name prevents one target
  // from attaching to another target's live relay.
  const sockName = relaySocketNameForInstanceId(relayInstanceId)
  const sockFile = relayEndpointForHost(hostPlatform, remoteDir, sockName)
  const endpointDir = relayHookEndpointDirForHost(hostPlatform, remoteDir, sockFile)

  if (isWindowsRemoteHost(hostPlatform)) {
    const activePipeMarkerPath = windowsActivePipeMarkerPath(hostPlatform, remoteDir, sockName)
    const activeEndpoint = (await readWindowsActiveRelayEndpoint(
      conn,
      hostPlatform,
      remoteDir,
      activePipeMarkerPath
    )) ?? {
      sockPath: sockFile,
      endpointDir
    }
    const fallbackEndpoint = buildWindowsRelayFallbackEndpoint(hostPlatform, remoteDir, sockName)
    return launchWindowsRelay(conn, hostPlatform, {
      remoteDir,
      nodePath,
      sockPath: activeEndpoint.sockPath,
      endpointDir: activeEndpoint.endpointDir,
      graceTime,
      activePipeMarkerPath,
      reconnectFallback: fallbackEndpoint
    })
  }

  // Why: after an app restart a relay may still be running in its grace
  // period with live PTY sessions.  We check for its Unix socket and
  // launch in --connect mode to bridge the new SSH channel to the
  // existing relay process — preserving PTY state and scrollback.
  try {
    const probeOutput = await execCommand(
      conn,
      `test -S ${shellEscape(sockFile)} && echo ALIVE || echo DEAD`
    )
    console.warn(`[ssh-relay] Socket probe result: "${probeOutput.trim()}"`)
    if (probeOutput.trim() === 'ALIVE') {
      console.log('[ssh-relay] Existing relay socket found, attempting reconnect...')
      try {
        const channel = await conn.exec(
          `cd ${escapedDir} && ${escapedNode} relay.js --connect --sock-path ${shellEscape(sockFile)}`
        )
        const transport = await waitForSentinel(channel)
        console.log('[ssh-relay] Reconnected to existing relay via socket')
        return { transport, nodePath, sockPath: sockFile }
      } catch (err) {
        console.warn(
          '[ssh-relay] Socket reconnect failed, launching fresh relay:',
          err instanceof Error ? err.message : String(err)
        )
        // Why: stale socket from a crashed relay — remove it so the
        // fresh launch can bind a new socket at the same path.
        await execCommand(conn, `rm -f ${shellEscape(sockFile)}`).catch(() => {})
      }
    }
  } catch {
    // Probe failed — fall through to fresh launch
  }

  // Why: the relay must outlive the SSH connection so PTY sessions survive
  // app restarts.  nohup prevents SIGHUP death, </dev/null detaches stdin,
  // and & backgrounds the process so it's not a direct child of the exec
  // channel.  When sshd tears down the session the relay continues as an
  // orphan adopted by init, listening on its Unix socket for a --connect
  // bridge from the next app launch.
  // Why: execCommand waits for the channel to close, but SSH channels stay
  // open while backgrounded children exist (even with fd redirection).
  // Fire-and-forget via conn.exec: we don't need the output — the socket
  // poll below detects readiness.
  const logFile = `${remoteDir}/relay.log`
  const launchCmd = `cd ${escapedDir} && nohup ${escapedNode} relay.js --detached --grace-time ${graceTime} --sock-path ${shellEscape(sockFile)} > ${shellEscape(logFile)} 2>&1 </dev/null &`
  const launchChannel = await conn.exec(launchCmd)
  launchChannel.on('data', () => {})
  launchChannel.on('error', () => {})
  launchChannel.stderr.on('data', () => {})
  launchChannel.stderr.on('error', () => {})
  // Why: the shell exits quickly (nohup ... &), but the SSH channel stays
  // open until all child fds close. Explicitly closing it after the poll
  // loop prevents channel accumulation across relay restarts, which would
  // eventually hit the server's MaxSessions limit.
  launchChannel.on('close', () => {})

  // Why: the backgrounded relay needs time to bind its Unix socket.  We
  // poll rather than sleep a fixed duration because remote host speed
  // varies widely (CI vs. Raspberry Pi).
  // Why: checking `test -S` only verifies the inode exists, not that the
  // relay is listening. After a stale socket removal + fresh launch, the
  // old inode can linger briefly. We probe with a connect-and-close to
  // confirm the socket is actually accepting connections.
  const POLL_INTERVAL_MS = 200
  const POLL_TIMEOUT_MS = 10_000
  const pollStart = Date.now()
  let socketReady = false
  while (Date.now() - pollStart < POLL_TIMEOUT_MS) {
    try {
      // Why: node is guaranteed to exist on the remote (we just deployed
      // the relay with it). Using it to probe the socket is more portable
      // than python3/socat/perl which may not be installed. The socket
      // path is passed as argv[1] to avoid shell quoting issues with -e.
      const result = await execCommand(
        conn,
        `${escapedNode} -e 'var s=require("net").connect(process.argv[1]);s.on("connect",function(){s.destroy();process.stdout.write("READY")});s.on("error",function(){process.stdout.write("WAITING")})' ${shellEscape(sockFile)} 2>/dev/null || (test -S ${shellEscape(sockFile)} && echo READY || echo WAITING)`
      )
      if (result.trim() === 'READY') {
        socketReady = true
        break
      }
    } catch {
      /* exec failed, retry */
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
  }

  // Why: close the fire-and-forget launch channel now that the relay's
  // socket is either ready or the poll timed out. Leaving it open leaks
  // an SSH channel per relay restart.
  launchChannel.close()

  if (!socketReady) {
    const logOutput = await execCommand(
      conn,
      `tail -20 ${shellEscape(logFile)} 2>/dev/null || echo "(no log)"`
    ).catch(() => '(could not read log)')
    throw new Error(`Relay failed to start within ${POLL_TIMEOUT_MS / 1000}s. Log:\n${logOutput}`)
  }

  // Why: the backgrounded relay's stdout goes to a log file, not the exec
  // channel.  We connect via --connect which bridges this new channel's
  // stdin/stdout to the relay's Unix socket — same path used for reconnect
  // after app restart.
  const channel = await conn.exec(
    `cd ${escapedDir} && ${escapedNode} relay.js --connect --sock-path ${shellEscape(sockFile)}`
  )
  return { transport: await waitForSentinel(channel), nodePath, sockPath: sockFile }
}

function buildWindowsRelayFallbackEndpoint(
  hostPlatform: RemoteHostPlatform,
  remoteDir: string,
  sockName: string
): WindowsRelayEndpoint {
  const fallbackSockName = windowsRelayFallbackSocketName(sockName)
  const sockPath = relayEndpointForHost(hostPlatform, remoteDir, fallbackSockName)
  return {
    sockPath,
    endpointDir: relayHookEndpointDirForHost(hostPlatform, remoteDir, sockPath)
  }
}

async function readWindowsActiveRelayEndpoint(
  conn: SshConnection,
  hostPlatform: RemoteHostPlatform,
  remoteDir: string,
  markerPath: string
): Promise<WindowsRelayEndpoint | null> {
  const output = await execHostCommand(
    conn,
    hostPlatform,
    powerShellCommand(
      `if (Test-Path -LiteralPath ${powerShellLiteral(markerPath)} -PathType Leaf) { Get-Content -LiteralPath ${powerShellLiteral(markerPath)} -Raw -ErrorAction SilentlyContinue }`
    )
  ).catch(() => '')
  const sockPath = output.trim()
  if (!isWindowsRelayPipePath(sockPath)) {
    return null
  }
  return {
    sockPath,
    endpointDir: relayHookEndpointDirForHost(hostPlatform, remoteDir, sockPath)
  }
}

async function rememberWindowsActiveRelayEndpoint(
  conn: SshConnection,
  hostPlatform: RemoteHostPlatform,
  markerPath: string,
  sockPath: string
): Promise<void> {
  await execHostCommand(
    conn,
    hostPlatform,
    powerShellCommand(
      `Set-Content -LiteralPath ${powerShellLiteral(markerPath)} -Value ${powerShellLiteral(sockPath)} -NoNewline`
    )
  ).catch((err) => {
    // Why: fallback pipe names are deterministic, so losing this marker does
    // not force the next deploy to orphan an undiscoverable relay.
    console.warn(
      `[ssh-relay] Failed to persist Windows active relay pipe at ${markerPath}: ${err instanceof Error ? err.message : String(err)}`
    )
  })
}

type WindowsRelayEndpoint = {
  sockPath: string
  endpointDir: string
}

type WindowsRelayLaunchOptions = {
  remoteDir: string
  nodePath: string
  graceTime: number
  activePipeMarkerPath: string
} & WindowsRelayEndpoint & {
    reconnectFallback?: WindowsRelayEndpoint
  }

async function launchWindowsRelay(
  conn: SshConnection,
  hostPlatform: RemoteHostPlatform,
  opts: WindowsRelayLaunchOptions
): Promise<{ transport: MultiplexerTransport; nodePath: string; sockPath: string }> {
  let launchOpts = opts
  if ((await probeWindowsRelayPipe(conn, hostPlatform, opts)) === 'READY') {
    try {
      const transport = await connectWindowsRelay(conn, hostPlatform, opts)
      await rememberWindowsActiveRelayEndpoint(
        conn,
        hostPlatform,
        opts.activePipeMarkerPath,
        opts.sockPath
      )
      return {
        transport,
        nodePath: opts.nodePath,
        sockPath: opts.sockPath
      }
    } catch (err) {
      console.warn(
        '[ssh-relay] Windows named pipe reconnect failed, launching fresh relay:',
        err instanceof Error ? err.message : String(err)
      )
      if (opts.reconnectFallback) {
        // Why: an existing Windows named pipe cannot be unlinked like a Unix
        // socket; use a deterministic fallback pipe so marker write failures
        // remain recoverable on the next deploy.
        // Keep activePipeMarkerPath keyed by the original target sock name;
        // the marker records the active pipe for that target, fallback or not.
        launchOpts = { ...opts, ...opts.reconnectFallback }
      }
    }
  }

  if (
    launchOpts !== opts &&
    (await probeWindowsRelayPipe(conn, hostPlatform, launchOpts)) === 'READY'
  ) {
    try {
      const transport = await connectWindowsRelay(conn, hostPlatform, launchOpts)
      await rememberWindowsActiveRelayEndpoint(
        conn,
        hostPlatform,
        launchOpts.activePipeMarkerPath,
        launchOpts.sockPath
      )
      return {
        transport,
        nodePath: launchOpts.nodePath,
        sockPath: launchOpts.sockPath
      }
    } catch (err) {
      console.warn(
        '[ssh-relay] Windows fallback pipe reconnect failed, relaunching relay:',
        err instanceof Error ? err.message : String(err)
      )
    }
  }

  const logFile = joinRemotePath(hostPlatform, launchOpts.remoteDir, 'relay.log')
  const errFile = joinRemotePath(hostPlatform, launchOpts.remoteDir, 'relay.err.log')
  await execHostCommand(
    conn,
    hostPlatform,
    windowsRelayLaunchCommand(
      hostPlatform,
      launchOpts.nodePath,
      launchOpts.remoteDir,
      launchOpts.sockPath,
      launchOpts.endpointDir,
      launchOpts.graceTime,
      logFile,
      errFile
    )
  )

  const POLL_INTERVAL_MS = 200
  const POLL_TIMEOUT_MS = 10_000
  if (
    await waitForWindowsRelayPipe(conn, hostPlatform, launchOpts, POLL_TIMEOUT_MS, POLL_INTERVAL_MS)
  ) {
    const transport = await connectWindowsRelay(conn, hostPlatform, launchOpts)
    await rememberWindowsActiveRelayEndpoint(
      conn,
      hostPlatform,
      launchOpts.activePipeMarkerPath,
      launchOpts.sockPath
    )
    return {
      transport,
      nodePath: launchOpts.nodePath,
      sockPath: launchOpts.sockPath
    }
  }

  const logOutput = await execHostCommand(
    conn,
    hostPlatform,
    windowsRelayTailLogCommand(logFile, errFile)
  ).catch(() => '(could not read log)')
  throw new Error(`Relay failed to start within ${POLL_TIMEOUT_MS / 1000}s. Log:\n${logOutput}`)
}

async function connectWindowsRelay(
  conn: SshConnection,
  hostPlatform: RemoteHostPlatform,
  opts: {
    remoteDir: string
    nodePath: string
    sockPath: string
  }
): Promise<MultiplexerTransport> {
  const channel = await conn.exec(
    windowsRelayConnectCommand(hostPlatform, opts.nodePath, opts.remoteDir, opts.sockPath),
    { wrapCommand: false }
  )
  return waitForSentinel(channel)
}

function windowsRelayConnectCommand(
  hostPlatform: RemoteHostPlatform,
  nodePath: string,
  remoteDir: string,
  sockPath: string
): string {
  return commandWithNodePath(
    hostPlatform,
    nodePath,
    remoteDir,
    `& ${powerShellLiteral(nodePath)} relay.js --connect --sock-path ${powerShellLiteral(sockPath)}`
  )
}

function windowsRelayLaunchCommand(
  hostPlatform: RemoteHostPlatform,
  nodePath: string,
  remoteDir: string,
  sockPath: string,
  endpointDir: string,
  graceTime: number,
  logFile: string,
  errFile: string
): string {
  const relayScript = joinRemotePath(hostPlatform, remoteDir, 'relay.js')
  return commandWithNodePath(
    hostPlatform,
    nodePath,
    remoteDir,
    [
      `$args = @(${windowsStartProcessArgumentLiteral(relayScript)}, '--detached', '--grace-time', ${powerShellLiteral(String(graceTime))}, '--sock-path', ${windowsStartProcessArgumentLiteral(sockPath)}, '--endpoint-dir', ${windowsStartProcessArgumentLiteral(endpointDir)})`,
      `Start-Process -FilePath ${powerShellLiteral(nodePath)} -ArgumentList $args -WorkingDirectory ${powerShellLiteral(remoteDir)} -RedirectStandardOutput ${powerShellLiteral(logFile)} -RedirectStandardError ${powerShellLiteral(errFile)} -WindowStyle Hidden`
    ].join('; ')
  )
}

function windowsStartProcessArgumentLiteral(value: string): string {
  return powerShellLiteral(`"${value.replace(/"/g, '\\"')}"`)
}

async function probeWindowsRelayPipe(
  conn: SshConnection,
  hostPlatform: RemoteHostPlatform,
  opts: {
    remoteDir: string
    nodePath: string
    sockPath: string
  }
): Promise<'READY' | 'WAITING'> {
  const result = await execHostCommand(
    conn,
    hostPlatform,
    windowsRelayProbeCommand(hostPlatform, opts.nodePath, opts.remoteDir, opts.sockPath)
  )
  return result.trim() === 'READY' ? 'READY' : 'WAITING'
}

async function waitForWindowsRelayPipe(
  conn: SshConnection,
  hostPlatform: RemoteHostPlatform,
  opts: {
    remoteDir: string
    nodePath: string
    sockPath: string
  },
  timeoutMs: number,
  intervalMs: number
): Promise<boolean> {
  try {
    const result = await execHostCommand(
      conn,
      hostPlatform,
      windowsRelayWaitCommand(hostPlatform, opts.nodePath, opts.remoteDir, opts.sockPath, {
        timeoutMs,
        intervalMs
      })
    )
    return result.trim() === 'READY'
  } catch {
    return false
  }
}

function windowsRelayProbeCommand(
  hostPlatform: RemoteHostPlatform,
  nodePath: string,
  remoteDir: string,
  sockPath: string
): string {
  const js = [
    'const net=require("net");',
    'const s=net.connect(process.argv[1]);',
    's.on("connect",()=>{s.destroy();process.stdout.write("READY")});',
    's.on("error",()=>{process.stdout.write("WAITING")});'
  ].join('')
  return commandWithNodePath(
    hostPlatform,
    nodePath,
    remoteDir,
    `& ${powerShellLiteral(nodePath)} -e ${powerShellLiteral(js)} ${powerShellLiteral(sockPath)}`
  )
}

function windowsRelayWaitCommand(
  hostPlatform: RemoteHostPlatform,
  nodePath: string,
  remoteDir: string,
  sockPath: string,
  opts: { timeoutMs: number; intervalMs: number }
): string {
  const js = [
    'const net=require("net");',
    'const pipe=process.argv[1];',
    'const timeoutMs=Number(process.argv[2]);',
    'const intervalMs=Number(process.argv[3]);',
    'const deadline=Date.now()+timeoutMs;',
    'function finish(value){process.stdout.write(value);process.exit(0)}',
    'function attempt(){',
    'const s=net.connect(pipe);',
    'let settled=false;',
    'function retry(){if(settled)return;settled=true;s.destroy();',
    'if(Date.now()>=deadline)finish("WAITING");else setTimeout(attempt,intervalMs)}',
    's.setTimeout(Math.min(intervalMs,500));',
    's.on("connect",()=>{if(settled)return;settled=true;s.destroy();finish("READY")});',
    's.on("timeout",retry);',
    's.on("error",retry);',
    '}',
    'attempt();'
  ].join('')
  return commandWithNodePath(
    hostPlatform,
    nodePath,
    remoteDir,
    [
      `& ${powerShellLiteral(nodePath)}`,
      '-e',
      powerShellLiteral(js),
      powerShellLiteral(sockPath),
      powerShellLiteral(String(opts.timeoutMs)),
      powerShellLiteral(String(opts.intervalMs))
    ].join(' ')
  )
}

function windowsRelayTailLogCommand(logFile: string, errFile: string): string {
  const script = [
    `$out = if (Test-Path -LiteralPath ${powerShellLiteral(logFile)}) { Get-Content -LiteralPath ${powerShellLiteral(logFile)} -Tail 20 -ErrorAction SilentlyContinue } else { '(no stdout log)' }`,
    `$err = if (Test-Path -LiteralPath ${powerShellLiteral(errFile)}) { Get-Content -LiteralPath ${powerShellLiteral(errFile)} -Tail 20 -ErrorAction SilentlyContinue } else { '(no stderr log)' }`,
    'Write-Output $out',
    "Write-Output '--- stderr ---'",
    'Write-Output $err'
  ].join('; ')
  return powerShellCommand(script)
}
