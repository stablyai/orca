import { join } from 'path'
/* eslint-disable max-lines -- Why: the relay-deploy module owns one cohesive
   contract — version detection, install-locked deploy, native-deps probe,
   relay launch, and GC — and splitting risks drift between the install
   sequence and the GC's live-socket invariant. */
import { existsSync } from 'fs'
import { app } from 'electron'
import { createHash } from 'crypto'
import type { SshConnection } from './ssh-connection'
import { parseUnameToRelayPlatform, type RelayPlatform } from './relay-protocol'
import type { MultiplexerTransport } from './ssh-channel-multiplexer'
import {
  uploadDirectory,
  waitForSentinel,
  execCommand,
  resolveRemoteNodePath
} from './ssh-relay-deploy-helpers'
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

export type RelayDeployResult = {
  transport: MultiplexerTransport
  platform: RelayPlatform
}

// Why: individual exec commands have 30s timeouts, but the full deploy
// pipeline (detect platform → check existing → upload → npm install →
// launch) has no overall bound. A hanging `npm install` or slow SFTP
// upload could block the connection indefinitely.
const RELAY_DEPLOY_TIMEOUT_MS = 120_000

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
  const platform = await detectRemotePlatform(conn)
  if (!platform) {
    throw new Error(
      'Unsupported remote platform. Orca relay supports: linux-x64, linux-arm64, darwin-x64, darwin-arm64.'
    )
  }
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

  // Why: SFTP does not expand `~`, so we must resolve the remote home directory
  // explicitly. `echo $HOME` over exec gives us the absolute path.
  const remoteHome = (await execCommand(conn, 'echo $HOME')).trim()
  // Why: we only interpolate $HOME into single-quoted shell strings later, so
  // this validation only needs to reject obviously unsafe control characters.
  // Allow spaces and non-ASCII so valid home directories are not rejected.
  // oxlint-disable-next-line no-control-regex
  if (!remoteHome || !remoteHome.startsWith('/') || /[\u0000\r\n]/.test(remoteHome)) {
    throw new Error(`Remote $HOME is not a valid path: ${remoteHome.slice(0, 100)}`)
  }
  const remoteRelayDir = computeRemoteRelayDir(remoteHome, fullVersion)
  console.log(`[ssh-relay] Remote dir: ${remoteRelayDir}`)

  onProgress?.('Checking existing relay...')
  const alreadyInstalled = await isRelayAlreadyInstalled(conn, remoteRelayDir)
  console.log(`[ssh-relay] Already installed at ${fullVersion}: ${alreadyInstalled}`)

  if (alreadyInstalled) {
    await repairInstalledNativeDeps(conn, remoteRelayDir, platform)
  } else {
    // Why: serialize concurrent first-installs of the same version against
    // each other via an atomic mkdir lock. The losing caller polls and either
    // re-checks `alreadyInstalled` (now true) or steals a stale lock.
    await acquireInstallLock(conn, remoteRelayDir)
    try {
      // Re-probe after acquiring the lock — a sibling installer may have
      // finished while we were waiting.
      if (!(await isRelayAlreadyInstalled(conn, remoteRelayDir))) {
        onProgress?.('Uploading relay...')
        console.log('[ssh-relay] Uploading relay...')
        await uploadRelay(conn, platform, remoteRelayDir, fullVersion)
        console.log('[ssh-relay] Upload complete')

        onProgress?.('Installing native dependencies...')
        console.log('[ssh-relay] Installing native dependencies...')
        await installNativeDeps(conn, remoteRelayDir, platform)
        console.log('[ssh-relay] Native deps installed')

        // Why: write `.install-complete` BEFORE releasing the lock so a
        // sibling never observes the dir as "complete but locked", which
        // would lead GC to skip a recoverable dir indefinitely.
        await finalizeInstall(conn, remoteRelayDir)
      } else {
        await abandonInstall(conn, remoteRelayDir)
      }
    } catch (err) {
      // Why: leave a partial install dir in place (no `.install-complete`)
      // so the next deploy detects the partial and re-runs upload + install.
      // Just release the lock so a concurrent caller can retry.
      await abandonInstall(conn, remoteRelayDir)
      throw err
    }
  }

  onProgress?.('Starting relay...')
  console.log('[ssh-relay] Launching relay...')
  const transport = await launchRelay(conn, remoteRelayDir, graceTimeSeconds, relayInstanceId)
  console.log('[ssh-relay] Relay started successfully')

  // Why: best-effort cleanup of unreferenced sibling version dirs. Errors
  // are logged inside gcOldRelayVersions and never propagate, so a GC failure
  // can never block the user from connecting.
  void gcOldRelayVersions(conn, remoteHome, remoteRelayDir).catch(() => {})

  return { transport, platform }
}

async function detectRemotePlatform(conn: SshConnection): Promise<RelayPlatform | null> {
  const output = await execCommand(conn, 'uname -sm')
  const parts = output.trim().split(/\s+/)
  if (parts.length < 2) {
    return null
  }
  return parseUnameToRelayPlatform(parts[0], parts[1])
}

async function uploadRelay(
  conn: SshConnection,
  platform: RelayPlatform,
  remoteDir: string,
  fullVersion: string
): Promise<void> {
  const localRelayDir = getLocalRelayPath(platform)
  if (!localRelayDir || !existsSync(localRelayDir)) {
    throw new Error(
      `Relay package for ${platform} not found. Searched: ${getLocalRelayCandidates(platform).join(', ')}. ` +
        `This may be a packaging issue — try reinstalling Orca.`
    )
  }

  // Create remote directory
  await execCommand(conn, `mkdir -p ${shellEscape(remoteDir)}`)

  // Upload via SFTP
  const sftp = await conn.sftp()

  try {
    await uploadDirectory(sftp, localRelayDir, remoteDir)
  } finally {
    sftp.end()
  }

  // Make the node binary executable
  await execCommand(conn, `chmod +x ${shellEscape(`${remoteDir}/node`)} 2>/dev/null; true`)

  // Why: write `.version` via SFTP rather than shell to avoid quoting issues
  // with content-hashed version strings. The remote daemon reads this same
  // file on startup so the wire-handshake validates against it.
  const versionSftp = await conn.sftp()
  try {
    await new Promise<void>((resolve, reject) => {
      const ws = versionSftp.createWriteStream(`${remoteDir}/.version`)
      ws.on('close', resolve)
      ws.on('error', reject)
      ws.end(fullVersion)
    })
  } finally {
    versionSftp.end()
  }
}

const RELAY_NATIVE_DEPS = {
  'node-pty': '1.1.0',
  '@parcel/watcher': '2.5.6'
} as const

async function hasRequiredNativeDeps(conn: SshConnection, remoteDir: string): Promise<boolean> {
  const nodePath = await resolveRemoteNodePath(conn)
  const nodeBinDir = nodePath.replace(/\/node$/, '')
  const escapedDir = shellEscape(remoteDir)
  const escapedBinDir = shellEscape(nodeBinDir)
  const escapedNode = shellEscape(nodePath)
  try {
    const probe = await execCommand(
      conn,
      `export PATH=${escapedBinDir}:$PATH && cd ${escapedDir} && (${escapedNode} -e 'require.resolve("node-pty"); require.resolve("@parcel/watcher"); console.log("ORCA-NATIVE-DEPS-OK")' 2>/dev/null || echo MISSING)`
    )
    return probe.includes('ORCA-NATIVE-DEPS-OK')
  } catch {
    return false
  }
}

async function repairInstalledNativeDeps(
  conn: SshConnection,
  remoteDir: string,
  platform: RelayPlatform
): Promise<void> {
  if (await hasRequiredNativeDeps(conn, remoteDir)) {
    return
  }

  console.warn(`[ssh-relay] Repairing missing native deps at ${remoteDir}`)
  await acquireInstallLock(conn, remoteDir)
  try {
    // Why: older complete relay dirs were created before @parcel/watcher was
    // installed. Re-probe under the lock so only one reconnect mutates the dir.
    if (!(await hasRequiredNativeDeps(conn, remoteDir))) {
      await installNativeDeps(conn, remoteDir, platform)
      await finalizeInstall(conn, remoteDir)
    } else {
      await abandonInstall(conn, remoteDir)
    }
  } catch (err) {
    await abandonInstall(conn, remoteDir)
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
  platform: RelayPlatform
): Promise<void> {
  const nodePath = await resolveRemoteNodePath(conn)
  // Why: node's bin directory must be in PATH for npm's child processes.
  // npm install runs node-pty's prebuild script (`node scripts/prebuild.js`)
  // which spawns `node` as a child — if node isn't in PATH, that child
  // fails with exit 127 even though we invoked npm via its full path.
  const nodeBinDir = nodePath.replace(/\/node$/, '')
  const escapedDir = shellEscape(remoteDir)
  const escapedBinDir = shellEscape(nodeBinDir)
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
  const sftpPkg = await conn.sftp()
  try {
    await new Promise<void>((resolve, reject) => {
      const ws = sftpPkg.createWriteStream(`${remoteDir}/package.json`)
      // .once: a session 'error' arriving after we've already resolved/rejected
      // would otherwise become an unhandled error and crash main.
      sftpPkg.once('error', reject)
      ws.once('close', resolve)
      ws.once('error', reject)
      ws.end(pkgJson)
    })
  } finally {
    sftpPkg.end()
  }

  try {
    const installArgs = Object.entries(RELAY_NATIVE_DEPS)
      .map(([dep, version]) => shellEscape(`${dep}@${version}`))
      .join(' ')
    await execCommand(
      conn,
      `export PATH=${escapedBinDir}:$PATH && cd ${escapedDir} && npm install --omit=dev --no-audit --no-fund ${installArgs} 2>&1`
    )
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
  await execCommand(
    conn,
    `find ${shellEscape(`${remoteDir}/node_modules/node-pty/prebuilds`)} -name spawn-helper -exec chmod +x {} + 2>/dev/null; true`
  )

  // node -e require() catches unloadable installs (wrong arch, missing
  // prebuild, broken native binding) that test -d cannot. Stderr → file
  // so .bashrc noise can't pollute the sentinel match; preserved for the
  // [NPTY-MISSING] breadcrumb. MISSING is non-fatal by design — see
  // docs/ssh-relay-versioned-install-dirs.md (relay still serves
  // fs/git/preflight; only pty.spawn fails at runtime).
  const PROBE_OK = 'ORCA-NPTY-PROBE-OK'
  const stderrFile = `${remoteDir}/.npty-probe.stderr`
  const escapedStderr = shellEscape(stderrFile)
  const probeOutput = await execCommand(
    conn,
    `export PATH=${escapedBinDir}:$PATH && cd ${escapedDir} && (${escapedNode} -e 'require("node-pty"); console.log(process.argv[1])' ${shellEscape(PROBE_OK)} 2>${escapedStderr} || echo MISSING)`
  )
  if (!probeOutput.includes(PROBE_OK)) {
    const remoteStderr = await execCommand(conn, `cat ${escapedStderr} 2>/dev/null; true`).catch(
      () => ''
    )
    console.warn(
      `[ssh-relay][NPTY-MISSING] node-pty installed but require() failed at ${remoteDir} (${platform}). stdout=${probeOutput.trim().slice(-200)} stderr=${remoteStderr.trim().slice(-500)}`
    )
  }
  await execCommand(conn, `rm -f ${escapedStderr} 2>/dev/null; true`).catch(() => {})
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
  graceTimeSeconds?: number,
  relayInstanceId?: string
): Promise<MultiplexerTransport> {
  // Why: Phase 1 of the plan requires Node.js on the remote. We use the
  // system `node` rather than bundling a node binary, keeping the relay
  // package small (~100KB JS vs ~60MB with embedded node).
  // Non-login SSH shells may not have node in PATH, so we source the
  // user's profile to pick up nvm/fnm/brew PATH entries.
  const nodePath = await resolveRemoteNodePath(conn)
  // Why: graceTimeSeconds originates from user-editable SshTarget config.
  // Clamping to integer prevents shell injection if the type ever loosened.
  const requestedGraceTime = Math.floor(graceTimeSeconds ?? 300)
  const graceTime = requestedGraceTime === 0 ? 0 : Math.max(60, Math.min(3600, requestedGraceTime))
  const escapedDir = shellEscape(remoteDir)
  const escapedNode = shellEscape(nodePath)
  // Why: remoteRelayDir is shared by every Orca target for the same remote
  // account. Hashing the target ID into the socket name prevents one target
  // from attaching to another target's live relay.
  const sockName = relayInstanceId
    ? `relay-${hashRelayInstanceId(relayInstanceId)}.sock`
    : 'relay.sock'
  const sockFile = `${remoteDir}/${sockName}`

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
        return transport
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
  return waitForSentinel(channel)
}

function hashRelayInstanceId(relayInstanceId: string): string {
  return createHash('sha256').update(relayInstanceId).digest('hex').slice(0, 16)
}
