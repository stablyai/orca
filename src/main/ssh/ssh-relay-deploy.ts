import { join } from 'node:path'
/* eslint-disable max-lines -- Why: one cohesive contract (version detect, install-locked deploy, native-deps probe, launch, GC); splitting risks install/GC drift. */
import { existsSync } from 'node:fs'
import { app } from 'electron'
import type { SshConnection } from './ssh-connection'
import type { RelayPlatform } from './relay-protocol'
import type { MultiplexerTransport } from './ssh-channel-multiplexer'
import {
  uploadDirectory,
  waitForSentinel,
  execCommand,
  isUnconfirmedSshCommandTermination
} from './ssh-relay-deploy-helpers'
import { resolveRemoteNodePath } from './ssh-remote-node-resolution'
import {
  readLocalFullVersion,
  computeRemoteRelayDir,
  isRelayAlreadyInstalled,
  finalizeInstall,
  abandonInstall,
  gcOldRelayVersions
} from './ssh-relay-versioned-install'
import { acquireInstallLock } from './ssh-relay-install-lock'
import { tryAcquireRelayRepairLock } from './ssh-relay-repair-lock'
import {
  releaseRelayGcClaimWithRetry,
  tryAcquireRelayGcClaim,
  waitForRelayGcClaimRelease
} from './ssh-relay-gc-claim'
import { NATIVE_DEPS_COMMAND_TIMEOUT_MS, RELAY_DEPLOY_TIMEOUT_MS } from './ssh-relay-deploy-timing'
import { createSshOperationAbortError, shellEscape } from './ssh-connection-utils'
import {
  probeBuildToolchain,
  formatMissingToolchainError,
  shouldProbeBuildToolchainAfterNativeDepsFailure
} from './ssh-relay-build-toolchain'
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
import { powerShellCommand, powerShellLiteral, powerShellNativeArg } from './ssh-remote-powershell'
import { relaySocketNameForInstanceId } from './ssh-relay-instance-id'
import { isSshSessionLimitError } from './ssh-session-limit-error'
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

class RelayDirectoryGcConflictError extends Error {
  constructor(
    readonly remoteRelayDir: string,
    readonly hostPlatform: RemoteHostPlatform
  ) {
    super(`Relay directory GC is in progress at ${remoteRelayDir}`)
  }
}

function execHostCommand(
  conn: SshConnection,
  hostPlatform: RemoteHostPlatform,
  command: string,
  options?: { timeoutMs?: number; signal?: AbortSignal }
): Promise<string> {
  return execCommand(conn, command, {
    wrapCommand: !isWindowsRemoteHost(hostPlatform),
    timeoutMs: options?.timeoutMs,
    signal: options?.signal
  })
}

/**
 * Deploy the relay to the remote host and launch it, returning the transport (relay's stdin/stdout) for multiplexer use.
 */
export async function deployAndLaunchRelay(
  conn: SshConnection,
  onProgress?: (status: string) => void,
  graceTimeSeconds?: number,
  relayInstanceId?: string
): Promise<RelayDeployResult> {
  let timeoutHandle: ReturnType<typeof setTimeout>
  // Why: Promise.race doesn't cancel its loser; abort so a contended install-lock waiter can't mutate the relay after this call times out.
  const deployAbortController = new AbortController()
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeoutHandle = setTimeout(() => {
      deployAbortController.abort()
      reject(new Error(`Relay deployment timed out after ${RELAY_DEPLOY_TIMEOUT_MS / 1000}s`))
    }, RELAY_DEPLOY_TIMEOUT_MS)
  })

  try {
    return await Promise.race([
      deployAndLaunchRelayInner(
        conn,
        onProgress,
        graceTimeSeconds,
        relayInstanceId,
        deployAbortController.signal
      ),
      timeoutPromise
    ])
  } finally {
    clearTimeout(timeoutHandle!)
  }
}

/**
 * Resolve the remote home, derive the versioned relay dir, and check whether the relay is installed there.
 *
 * Why: extracted to run concurrently with node-path resolution; home and install-check stay sequential because the check needs the resolved dir.
 */
async function resolveRemoteInstallState(
  conn: SshConnection,
  hostPlatform: RemoteHostPlatform,
  fullVersion: string,
  options?: { rethrowSessionLimitErrors?: boolean; signal?: AbortSignal }
): Promise<{ remoteHome: string; remoteRelayDir: string; alreadyInstalled: boolean }> {
  // Why: SFTP doesn't expand `~`, so resolve the remote home explicitly via the host's native shell and normalize it.
  const remoteHome = normalizeRemoteHome(
    await execHostCommand(conn, hostPlatform, readRemoteHomeCommand(hostPlatform), {
      signal: options?.signal
    }),
    hostPlatform
  )
  // Why: $HOME is only used inside single-quoted shell strings, so validation only rejects control chars — spaces and non-ASCII stay valid.
  if (!validateRemoteHome(remoteHome, hostPlatform)) {
    throw new Error(`Remote home is not a valid path: ${remoteHome.slice(0, 100)}`)
  }
  const remoteRelayDir = computeRemoteRelayDir(remoteHome, fullVersion, hostPlatform.pathFlavor)
  const probeOptions =
    options?.rethrowSessionLimitErrors || options?.signal
      ? {
          rethrowSessionLimitErrors: options.rethrowSessionLimitErrors,
          signal: options.signal
        }
      : undefined
  const alreadyInstalled = await isRelayAlreadyInstalled(
    conn,
    remoteRelayDir,
    hostPlatform,
    probeOptions
  )
  return { remoteHome, remoteRelayDir, alreadyInstalled }
}

type RelayBootstrapState = {
  remoteHome: string
  remoteRelayDir: string
  alreadyInstalled: boolean
  nodePath: string
}

async function resolveRelayBootstrapStateSequentially(
  conn: SshConnection,
  hostPlatform: RemoteHostPlatform,
  fullVersion: string,
  signal?: AbortSignal
): Promise<RelayBootstrapState> {
  const installState = await resolveRemoteInstallState(conn, hostPlatform, fullVersion, { signal })
  const nodePath = await resolveRemoteNodePath(conn, hostPlatform, { signal })
  return { ...installState, nodePath }
}

async function resolveRelayBootstrapState(
  conn: SshConnection,
  hostPlatform: RemoteHostPlatform,
  fullVersion: string,
  signal?: AbortSignal
): Promise<RelayBootstrapState> {
  if (!conn.canRunConcurrentExecCommands()) {
    return resolveRelayBootstrapStateSequentially(conn, hostPlatform, fullVersion, signal)
  }
  const abortController = new AbortController()
  const abortForDeploy = (): void => abortController.abort()
  signal?.addEventListener('abort', abortForDeploy, { once: true })
  if (signal?.aborted) {
    abortForDeploy()
  }
  const installStatePromise = resolveRemoteInstallState(conn, hostPlatform, fullVersion, {
    rethrowSessionLimitErrors: true,
    signal: abortController.signal
  })
  const nodePathPromise = resolveRemoteNodePath(conn, hostPlatform, {
    rethrowSessionLimitErrors: true,
    signal: abortController.signal
  })
  try {
    const [installState, nodePath] = await Promise.all([installStatePromise, nodePathPromise])
    signal?.throwIfAborted()
    return { ...installState, nodePath }
  } catch (err) {
    abortController.abort()
    const settled = await Promise.allSettled([installStatePromise, nodePathPromise])
    signal?.throwIfAborted()
    if (!isSshSessionLimitError(err)) {
      throw err
    }
    const nonSessionFailure = settled.find(
      (result) =>
        result.status === 'rejected' &&
        !isSshSessionLimitError(result.reason) &&
        !isAbortError(result.reason)
    )
    if (nonSessionFailure?.status === 'rejected') {
      throw nonSessionFailure.reason
    }
    console.warn(
      '[ssh-relay] Concurrent bootstrap probes hit the remote SSH session limit; retrying sequentially.'
    )
    return resolveRelayBootstrapStateSequentially(conn, hostPlatform, fullVersion, signal)
  } finally {
    signal?.removeEventListener('abort', abortForDeploy)
  }
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError'
}

/**
 * Detect platform, resolve install state + node path, install if absent, launch, and return the transport.
 * Inner implementation wrapped by `deployAndLaunchRelay` with an overall timeout.
 */
async function deployAndLaunchRelayInner(
  conn: SshConnection,
  onProgress?: (status: string) => void,
  graceTimeSeconds?: number,
  relayInstanceId?: string,
  deploySignal?: AbortSignal
): Promise<RelayDeployResult> {
  while (true) {
    deploySignal?.throwIfAborted()
    try {
      return await deployAndLaunchRelayAttempt(
        conn,
        onProgress,
        graceTimeSeconds,
        relayInstanceId,
        deploySignal
      )
    } catch (err) {
      if (!(err instanceof RelayDirectoryGcConflictError)) {
        throw err
      }
      // Why: GC atomically moves the old install aside; wait for its sibling claim to clear, then recompute install state.
      await waitForRelayGcClaimRelease(conn, err.remoteRelayDir, err.hostPlatform, deploySignal)
    }
  }
}

async function deployAndLaunchRelayAttempt(
  conn: SshConnection,
  onProgress?: (status: string) => void,
  graceTimeSeconds?: number,
  relayInstanceId?: string,
  deploySignal?: AbortSignal
): Promise<RelayDeployResult> {
  onProgress?.('Detecting remote platform...')
  console.log('[ssh-relay] Detecting remote platform...')
  const hostPlatform = await detectRemoteHostPlatform(conn, { signal: deploySignal })
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
  // Why: content-hashed version doubles as remote dir name and wire-handshake version; throws on missing rather than falling back (see docs/ssh-relay-versioned-install-dirs.md).
  const fullVersion = readLocalFullVersion(localRelayDir)

  onProgress?.('Checking existing relay...')
  // Why: install-check and node resolution are independent; run concurrently to save a round trip, with sequential fallback for restrictive SSH servers.
  const { remoteHome, remoteRelayDir, alreadyInstalled, nodePath } =
    await resolveRelayBootstrapState(conn, hostPlatform, fullVersion, deploySignal)
  console.log(`[ssh-relay] Remote dir: ${remoteRelayDir}`)
  console.log(`[ssh-relay] Already installed at ${fullVersion}: ${alreadyInstalled}`)

  let ownsInstallLock = false
  let launchGcClaimToken: string | undefined
  if (alreadyInstalled) {
    const launchFence = await repairInstalledNativeDeps(
      conn,
      remoteRelayDir,
      platform,
      hostPlatform,
      nodePath,
      deploySignal
    )
    ownsInstallLock = launchFence.ownsInstallLock
    launchGcClaimToken = launchFence.gcClaimToken
    deploySignal?.throwIfAborted()
  } else {
    // Why: serialize concurrent first-installs via a host-native exclusive lock; the loser polls to re-check installed or steal a stale lock.
    await acquireInstallLock(conn, remoteRelayDir, hostPlatform, { signal: deploySignal })
    ownsInstallLock = true
    try {
      // Re-probe after acquiring the lock — a sibling installer may have finished while we waited.
      if (
        !(await isRelayAlreadyInstalled(conn, remoteRelayDir, hostPlatform, {
          signal: deploySignal
        }))
      ) {
        onProgress?.('Uploading relay...')
        console.log('[ssh-relay] Uploading relay...')
        await uploadRelay(conn, platform, remoteRelayDir, fullVersion, hostPlatform, deploySignal)
        console.log('[ssh-relay] Upload complete')

        onProgress?.('Installing native dependencies...')
        console.log('[ssh-relay] Installing native dependencies...')
        await installNativeDeps(
          conn,
          remoteRelayDir,
          platform,
          hostPlatform,
          nodePath,
          deploySignal
        )
        console.log('[ssh-relay] Native deps installed')

        // Why: mark complete but retain the lock until launch makes daemon liveness observable to cross-version GC.
        await finalizeInstall(conn, remoteRelayDir, hostPlatform, {
          signal: deploySignal,
          releaseLock: false
        })
      }
    } catch (err) {
      // Why: leave a partial install dir (no .install-complete) so the next deploy re-runs upload + install.
      // Why: keep the lock if remote termination was unconfirmed — stale recovery beats overlapping a still-running npm.
      if (!isUnconfirmedSshCommandTermination(err)) {
        await abandonInstall(conn, remoteRelayDir, hostPlatform)
        ownsInstallLock = false
      }
      throw err
    }
  }

  let launched: Awaited<ReturnType<typeof launchRelay>>
  let launchLivenessObserved = false
  try {
    deploySignal?.throwIfAborted()
    onProgress?.('Starting relay...')
    console.log('[ssh-relay] Launching relay...')
    launched = await launchRelay(
      conn,
      remoteRelayDir,
      hostPlatform,
      nodePath,
      graceTimeSeconds,
      relayInstanceId,
      deploySignal
    )
    launchLivenessObserved = true
  } finally {
    // Why: older clients understand only the install lock; if launch never goes live, keep it so their GC can't race a caller waiting behind this owner.
    if (ownsInstallLock && launchLivenessObserved) {
      await abandonInstall(conn, remoteRelayDir, hostPlatform)
    }
    // The detached start may outlive a timed-out SSH command; keep the fence on failed launch until stale recovery proves the handoff ended.
    if (launchGcClaimToken && launchLivenessObserved) {
      await releaseRelayGcClaimWithRetry(conn, remoteRelayDir, launchGcClaimToken, hostPlatform)
    }
  }
  console.log('[ssh-relay] Relay started successfully')

  // Why: best-effort GC of unreferenced sibling version dirs; errors are swallowed so a GC failure never blocks connecting.
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
  hostPlatform: RemoteHostPlatform,
  signal?: AbortSignal
): Promise<void> {
  const localRelayDir = getLocalRelayPath(platform)
  if (!localRelayDir || !existsSync(localRelayDir)) {
    throw new Error(
      `Relay package for ${platform} not found. Searched: ${getLocalRelayCandidates(platform).join(', ')}. ` +
        `This may be a packaging issue — try reinstalling Orca.`
    )
  }

  await execHostCommand(conn, hostPlatform, makeRemoteDirectoryCommand(hostPlatform, remoteDir), {
    signal
  })

  await uploadDirectoryForConnection(conn, localRelayDir, remoteDir, hostPlatform, signal)

  if (!isWindowsRemoteHost(hostPlatform)) {
    await execHostCommand(
      conn,
      hostPlatform,
      makeRemoteExecutableCommand(hostPlatform, joinRemotePath(hostPlatform, remoteDir, 'node')),
      { signal }
    )
  }

  // Why: write .version via SFTP not shell to avoid quoting content-hashed versions; the daemon reads it to validate the wire handshake.
  await writeRemoteFile(
    conn,
    hostPlatform,
    joinRemotePath(hostPlatform, remoteDir, '.version'),
    fullVersion,
    signal
  )
}

async function uploadDirectoryForConnection(
  conn: SshConnection,
  localRelayDir: string,
  remoteDir: string,
  hostPlatform: RemoteHostPlatform,
  signal?: AbortSignal
): Promise<void> {
  if (typeof conn.uploadDirectory === 'function') {
    await conn.uploadDirectory(localRelayDir, remoteDir, { hostPlatform, signal })
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
  contents: string,
  signal?: AbortSignal
): Promise<void> {
  if (typeof conn.writeFile === 'function') {
    await conn.writeFile(remotePath, contents, { hostPlatform, signal })
    return
  }

  const sftp = await conn.sftp()
  try {
    await new Promise<void>((resolve, reject) => {
      const ws = sftp.createWriteStream(remotePath)
      // .once: a late session 'error' after resolve/reject would otherwise be unhandled and crash main.
      sftp.once('error', reject)
      ws.once('close', resolve)
      ws.once('error', reject)
      ws.end(contents)
    })
  } finally {
    sftp.end()
  }
}

const NODE_PTY_VERSION = '1.1.0'
const NODE_PTY_CONSOLE_LIST_PATCH_FILENAME = 'node-pty-1.1.0-console-list-agent-patch.cjs'
const RELAY_NATIVE_DEPS = {
  'node-pty': NODE_PTY_VERSION,
  '@parcel/watcher': '2.5.6'
} as const

type RelayNativeDepName = keyof typeof RELAY_NATIVE_DEPS
const RELAY_NATIVE_DEP_NAMES = Object.keys(RELAY_NATIVE_DEPS) as RelayNativeDepName[]
const NATIVE_DEPS_MISSING_PREFIX = 'ORCA-NATIVE-DEPS-MISSING:'

// Why: npm 12 blocks dependency lifecycle scripts unless each exact package version is approved, even with ignore-scripts disabled.
const RELAY_NATIVE_DEP_SCRIPT_ALLOWLIST = Object.fromEntries(
  Object.entries(RELAY_NATIVE_DEPS).map(([name, version]) => [`${name}@${version}`, true])
)

function nativeDepsProbeJs(successToken: string): string {
  // Why: node-pty's Windows wrapper defers conpty.node until first spawn, so require("node-pty") alone can't prove the binding is healthy.
  const loadNodePty =
    'require("node-pty"); require("node-pty/lib/utils").loadNativeModule(process.platform==="win32"&&Number(require("os").release().split(".")[2])>=18309?"conpty":"pty");' +
    `if(process.platform==="win32"){require("./${NODE_PTY_CONSOLE_LIST_PATCH_FILENAME}").assertPatchedNodePtyConsoleListAgent(process.cwd())}`
  return `(()=>{const missing=[];try{${loadNodePty}}catch{missing.push("node-pty")}try{require("@parcel/watcher")}catch{missing.push("@parcel/watcher")}if(missing.length){console.log("${NATIVE_DEPS_MISSING_PREFIX}"+missing.join(","));process.exitCode=1}else{console.log(${JSON.stringify(successToken)})}})()`
}

function missingNativeDepsFromProbe(output: string): RelayNativeDepName[] {
  const marker = output
    .split(/\r?\n/)
    .find((line) => line.trim().startsWith(NATIVE_DEPS_MISSING_PREFIX))
  if (!marker) {
    return [...RELAY_NATIVE_DEP_NAMES]
  }
  const reported = marker.trim().slice(NATIVE_DEPS_MISSING_PREFIX.length).split(',')
  return RELAY_NATIVE_DEP_NAMES.filter((name) => reported.includes(name))
}

async function probeRequiredNativeDeps(
  conn: SshConnection,
  remoteDir: string,
  hostPlatform: RemoteHostPlatform,
  nodePath: string,
  signal?: AbortSignal
): Promise<{ available: boolean; missing: RelayNativeDepName[] }> {
  const escapedNode = shellEscape(nodePath)
  const probeJs = nativeDepsProbeJs('ORCA-NATIVE-DEPS-OK')
  try {
    const command = isWindowsRemoteHost(hostPlatform)
      ? commandWithNodePath(
          hostPlatform,
          nodePath,
          remoteDir,
          `try { & ${powerShellLiteral(nodePath)} -e ${powerShellNativeArg(probeJs)} } catch { 'MISSING' }`
        )
      : commandWithNodePath(
          hostPlatform,
          nodePath,
          remoteDir,
          `(${escapedNode} -e ${shellEscape(probeJs)} 2>/dev/null || echo MISSING)`
        )
    const probe = await execHostCommand(conn, hostPlatform, command, { signal })
    const available = probe.includes('ORCA-NATIVE-DEPS-OK')
    return { available, missing: available ? [] : missingNativeDepsFromProbe(probe) }
  } catch {
    signal?.throwIfAborted()
    return { available: false, missing: [...RELAY_NATIVE_DEP_NAMES] }
  }
}

async function repairInstalledNativeDeps(
  conn: SshConnection,
  remoteDir: string,
  platform: RelayPlatform,
  hostPlatform: RemoteHostPlatform,
  nodePath: string,
  signal?: AbortSignal
): Promise<{ ownsInstallLock: boolean; gcClaimToken?: string }> {
  const initialProbe = await probeRequiredNativeDeps(
    conn,
    remoteDir,
    hostPlatform,
    nodePath,
    signal
  )
  const lockResult = await tryAcquireRelayRepairLock(conn, remoteDir, hostPlatform, { signal })
  if (lockResult === 'gc') {
    throw new RelayDirectoryGcConflictError(remoteDir, hostPlatform)
  }
  if (lockResult === 'acquired') {
    let stillInstalled: boolean
    try {
      stillInstalled = await isRelayAlreadyInstalled(conn, remoteDir, hostPlatform, {
        rethrowSessionLimitErrors: true,
        signal
      })
    } catch (err) {
      await abandonInstall(conn, remoteDir, hostPlatform)
      throw err
    }
    if (!stillInstalled) {
      // Why: GC may finish its rename before our lock recreates the path; never trust probes made before this locked recheck.
      await abandonInstall(conn, remoteDir, hostPlatform)
      throw new RelayDirectoryGcConflictError(remoteDir, hostPlatform)
    }
  }
  const gcClaimToken =
    lockResult === 'busy' || lockResult === 'error'
      ? await acquireRelayLaunchGcFence(conn, remoteDir, hostPlatform, signal)
      : undefined
  if (initialProbe.available) {
    // Why: even a healthy reconnect stays fenced until launch liveness is observable, or cross-version GC can rename after this probe.
    return { ownsInstallLock: lockResult === 'acquired', gcClaimToken }
  }

  // Why: an already-installed relay can launch degraded, so native-deps repair is best-effort — lock contention and failures must not abort the connection.
  console.warn(`[ssh-relay] Repairing missing native deps at ${remoteDir}`)
  if (lockResult === 'busy' || lockResult === 'error') {
    console.warn(
      `[ssh-relay] Native-deps repair lock is ${lockResult} at ${remoteDir}; launching degraded`
    )
    return { ownsInstallLock: false, gcClaimToken }
  }
  try {
    // Why: older complete relay dirs predate @parcel/watcher; re-probe under the lock so only one reconnect mutates the dir.
    const probe = await probeRequiredNativeDeps(conn, remoteDir, hostPlatform, nodePath, signal)
    if (!probe.available) {
      await installNativeDeps(
        conn,
        remoteDir,
        platform,
        hostPlatform,
        nodePath,
        signal,
        probe.missing
      )
      await finalizeInstall(conn, remoteDir, hostPlatform, { signal, releaseLock: false })
    }
    return { ownsInstallLock: true }
  } catch (err) {
    const terminationUnconfirmed = isUnconfirmedSshCommandTermination(err)
    // Why: hold a confirmed-failure lock through degraded launch so GC can't move the relay before liveness is visible.
    // Why: unconfirmed remote mutation keeps its stale-recoverable lock beyond this connection.
    console.warn(
      `[ssh-relay] Native deps repair failed at ${remoteDir}; launching degraded: ${
        err instanceof Error ? err.message : String(err)
      }`
    )
    return { ownsInstallLock: !terminationUnconfirmed }
  }
}

async function acquireRelayLaunchGcFence(
  conn: SshConnection,
  remoteDir: string,
  hostPlatform: RemoteHostPlatform,
  signal?: AbortSignal
): Promise<string> {
  const token = await tryAcquireRelayGcClaim(conn, remoteDir, hostPlatform, signal)
  if (!token) {
    signal?.throwIfAborted()
    throw new RelayDirectoryGcConflictError(remoteDir, hostPlatform)
  }
  try {
    signal?.throwIfAborted()
    const stillInstalled = await isRelayAlreadyInstalled(conn, remoteDir, hostPlatform, {
      rethrowSessionLimitErrors: true,
      signal
    })
    if (!stillInstalled) {
      throw new RelayDirectoryGcConflictError(remoteDir, hostPlatform)
    }
    // Why: a caller without the install lock still needs its own durable fence; never borrow another connection's lock through launch.
    return token
  } catch (err) {
    await releaseRelayGcClaimWithRetry(conn, remoteDir, token, hostPlatform)
    throw err
  }
}

// Why: node-pty and @parcel/watcher are native addons esbuild can't bundle; install them on the remote against its Node/OS.
// TODO(#1693): ship per-platform tarballs with node-pty prebuilt from CI to skip remote npm install.
async function installNativeDeps(
  conn: SshConnection,
  remoteDir: string,
  platform: RelayPlatform,
  hostPlatform: RemoteHostPlatform,
  nodePath: string,
  signal?: AbortSignal,
  resetDeps: RelayNativeDepName[] = []
): Promise<void> {
  // Why: node-pty's prebuild spawns `node` as a child, so node must be in PATH (commandWithNodePath) or it fails exit 127.
  // Why: npm init -y rejects '+' in content-hashed dir names, so write a fixed minimal package.json instead.
  // Why: type:commonjs pins module resolution against Node default flips or a remote ~/.npmrc type=module.
  const pkgJson = `${JSON.stringify({
    name: 'orca-relay',
    version: '1.0.0',
    private: true,
    type: 'commonjs',
    dependencies: RELAY_NATIVE_DEPS,
    allowScripts: RELAY_NATIVE_DEP_SCRIPT_ALLOWLIST
  })}\n`
  await writeRemoteFile(
    conn,
    hostPlatform,
    joinRemotePath(hostPlatform, remoteDir, 'package.json'),
    pkgJson,
    signal
  )

  try {
    const installArgs = Object.entries(RELAY_NATIVE_DEPS)
      .map(([dep, version]) => shellEscape(`${dep}@${version}`))
      .join(' ')
    // Why: npm reports a present package as up to date even if a native file was deleted; reset only deps the probe found broken.
    const resetCommand = resetNativeDepsCommand(hostPlatform, resetDeps)
    const resetPrefix = resetCommand ? `${resetCommand}; ` : ''
    const command = isWindowsRemoteHost(hostPlatform)
      ? commandWithNodePath(
          hostPlatform,
          nodePath,
          remoteDir,
          `${resetPrefix}npm install --ignore-scripts=false --omit=dev --no-audit --no-fund ${Object.entries(
            RELAY_NATIVE_DEPS
          )
            .map(([dep, version]) => powerShellLiteral(`${dep}@${version}`))
            .join(
              ' '
            )}; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; ${windowsNodePtyPatchCommand(nodePath)}`
        )
      : commandWithNodePath(
          hostPlatform,
          nodePath,
          remoteDir,
          `${resetPrefix}npm install --ignore-scripts=false --omit=dev --no-audit --no-fund ${installArgs} 2>&1`
        )
    await execHostCommand(conn, hostPlatform, command, {
      timeoutMs: NATIVE_DEPS_COMMAND_TIMEOUT_MS,
      signal
    })
  } catch (err) {
    if (isUnconfirmedSshCommandTermination(err)) {
      throw err
    }
    signal?.throwIfAborted()
    // Don't write .install-complete on hard fail so reconnect retries the partial install; greppable token aids bug reports.
    const msg = (err as Error).message
    console.warn(
      `[ssh-relay][NATIVE-DEPS-INSTALL-FAIL] npm install native deps failed at ${remoteDir} (${platform}): ${msg}`
    )
    // Why: on Linux node-pty compiles, so a missing C/C++ toolchain is the dominant first-connect failure (#1693); probe to give an actionable install hint.
    if (platform.startsWith('linux') && shouldProbeBuildToolchainAfterNativeDepsFailure(msg)) {
      const toolchain = await probeBuildToolchain(conn, hostPlatform, signal)
      if (toolchain?.toolchainMissing) {
        throw new Error(formatMissingToolchainError(toolchain, msg))
      }
    }
    throw err
  }

  await makeNodePtySpawnHelperExecutable(conn, remoteDir, hostPlatform, signal)

  let probe = await probeInstalledNativeDeps(conn, remoteDir, hostPlatform, nodePath, signal)
  if (!probe.available) {
    // Why: npm treats an already-present package as up to date, so re-enabling lifecycle scripts on install can't repair a skipped binding.
    console.warn(`[ssh-relay] Rebuilding unloadable native deps at ${remoteDir}`)
    let rebuilt = false
    try {
      await rebuildNativeDeps(conn, remoteDir, hostPlatform, nodePath, signal)
      rebuilt = true
    } catch (err) {
      if (isUnconfirmedSshCommandTermination(err)) {
        throw err
      }
      signal?.throwIfAborted()
      console.warn(
        `[ssh-relay][NATIVE-DEPS-REBUILD-FAIL] npm rebuild native deps failed at ${remoteDir} (${platform}): ${(err as Error).message}`
      )
    }
    signal?.throwIfAborted()
    if (rebuilt) {
      await makeNodePtySpawnHelperExecutable(conn, remoteDir, hostPlatform, signal)
      probe = await probeInstalledNativeDeps(conn, remoteDir, hostPlatform, nodePath, signal)
    }
  }

  // MISSING is non-fatal by design: the relay still serves fs/git/preflight; only native-backed ops fail on hosts that can't build the addons.
  if (!probe.available) {
    console.warn(
      `[ssh-relay][NPTY-MISSING] native deps installed but require() failed at ${remoteDir} (${platform}). stdout=${probe.output.trim().slice(-200)} stderr=${probe.stderr.trim().slice(-500)}`
    )
  }
}

function resetNativeDepsCommand(
  hostPlatform: RemoteHostPlatform,
  resetDeps: RelayNativeDepName[]
): string {
  if (resetDeps.length === 0) {
    return ''
  }
  const resetNodePty = resetDeps.includes('node-pty')
  const resetWatcher = resetDeps.includes('@parcel/watcher')
  if (isWindowsRemoteHost(hostPlatform)) {
    const commands: string[] = []
    if (resetNodePty) {
      commands.push(
        `Remove-Item -LiteralPath ${powerShellLiteral('node_modules/node-pty')} -Recurse -Force -ErrorAction SilentlyContinue`
      )
    }
    if (resetWatcher) {
      commands.push(
        `Remove-Item -LiteralPath ${powerShellLiteral('node_modules/@parcel/watcher')} -Recurse -Force -ErrorAction SilentlyContinue`,
        `$parcelScope = ${powerShellLiteral('node_modules/@parcel')}`,
        `Get-ChildItem -LiteralPath $parcelScope -Force -ErrorAction SilentlyContinue | Where-Object { $_.Name.StartsWith('watcher-', [StringComparison]::Ordinal) } | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue`
      )
    }
    return commands.join('; ')
  }
  const commands: string[] = []
  if (resetNodePty) {
    commands.push(`rm -rf ${shellEscape('node_modules/node-pty')}`)
  }
  if (resetWatcher) {
    commands.push(
      `rm -rf ${shellEscape('node_modules/@parcel/watcher')}`,
      `find ${shellEscape('node_modules/@parcel')} -maxdepth 1 -name 'watcher-*' -exec rm -rf {} + 2>/dev/null || true`
    )
  }
  return commands.join('; ')
}

async function rebuildNativeDeps(
  conn: SshConnection,
  remoteDir: string,
  hostPlatform: RemoteHostPlatform,
  nodePath: string,
  signal?: AbortSignal
): Promise<void> {
  const depNames = Object.keys(RELAY_NATIVE_DEPS)
  const command = isWindowsRemoteHost(hostPlatform)
    ? commandWithNodePath(
        hostPlatform,
        nodePath,
        remoteDir,
        `npm rebuild --ignore-scripts=false ${depNames.map(powerShellLiteral).join(' ')}; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; ${windowsNodePtyPatchCommand(nodePath)}`
      )
    : commandWithNodePath(
        hostPlatform,
        nodePath,
        remoteDir,
        `npm rebuild --ignore-scripts=false ${depNames.map(shellEscape).join(' ')} 2>&1`
      )
  await execHostCommand(conn, hostPlatform, command, {
    timeoutMs: NATIVE_DEPS_COMMAND_TIMEOUT_MS,
    signal
  })
}

function windowsNodePtyPatchCommand(nodePath: string): string {
  // Why: pnpm patches do not cross the SSH boundary; apply the version-checked fallback to the remote npm package.
  return `& ${powerShellLiteral(nodePath)} ${powerShellLiteral(NODE_PTY_CONSOLE_LIST_PATCH_FILENAME)}; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }`
}

async function makeNodePtySpawnHelperExecutable(
  conn: SshConnection,
  remoteDir: string,
  hostPlatform: RemoteHostPlatform,
  signal?: AbortSignal
): Promise<void> {
  if (isWindowsRemoteHost(hostPlatform)) {
    return
  }
  // SFTP doesn't preserve execute bits; node-pty's spawn-helper must be +x for posix_spawnp.
  await execHostCommand(
    conn,
    hostPlatform,
    `find ${shellEscape(joinRemotePath(hostPlatform, remoteDir, 'node_modules/node-pty/prebuilds'))} -name spawn-helper -exec chmod +x {} + 2>/dev/null; true`,
    { signal }
  )
}

async function probeInstalledNativeDeps(
  conn: SshConnection,
  remoteDir: string,
  hostPlatform: RemoteHostPlatform,
  nodePath: string,
  signal?: AbortSignal
): Promise<{
  available: boolean
  missing: RelayNativeDepName[]
  output: string
  stderr: string
}> {
  // require() catches unloadable installs (wrong arch, missing prebuild, skipped lifecycle script) that require.resolve() and test -d miss.
  const PROBE_OK = 'ORCA-NPTY-PROBE-OK'
  const stderrFile = joinRemotePath(hostPlatform, remoteDir, '.npty-probe.stderr')
  const escapedStderr = shellEscape(stderrFile)
  const probeJs = nativeDepsProbeJs(PROBE_OK)
  const probeCommand = isWindowsRemoteHost(hostPlatform)
    ? commandWithNodePath(
        hostPlatform,
        nodePath,
        remoteDir,
        `try { & ${powerShellLiteral(nodePath)} -e ${powerShellNativeArg(probeJs)} ${powerShellLiteral(PROBE_OK)}; if ($LASTEXITCODE -ne 0) { 'MISSING' } } catch { 'MISSING' }`
      )
    : commandWithNodePath(
        hostPlatform,
        nodePath,
        remoteDir,
        `(${shellEscape(nodePath)} -e ${shellEscape(probeJs)} ${shellEscape(PROBE_OK)} 2>${escapedStderr} || echo MISSING)`
      )
  const probeOutput = await execHostCommand(conn, hostPlatform, probeCommand, { signal })
  const remoteStderr =
    probeOutput.includes(PROBE_OK) || isWindowsRemoteHost(hostPlatform)
      ? ''
      : await execHostCommand(conn, hostPlatform, `cat ${escapedStderr} 2>/dev/null; true`, {
          signal
        }).catch(() => '')
  signal?.throwIfAborted()
  if (!isWindowsRemoteHost(hostPlatform)) {
    // The POSIX probe redirects stderr to this file; the Windows probe does not.
    await execHostCommand(conn, hostPlatform, removeRemoteFileCommand(hostPlatform, stderrFile), {
      signal
    }).catch(() => {})
    signal?.throwIfAborted()
  }
  return {
    available: probeOutput.includes(PROBE_OK),
    missing: probeOutput.includes(PROBE_OK) ? [] : missingNativeDepsFromProbe(probeOutput),
    output: probeOutput,
    stderr: remoteStderr
  }
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

  // Why: electron-builder copies extraResources next to the app bundle, but app.getAppPath() points at app.asar in packaged builds.
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
  relayInstanceId?: string,
  signal?: AbortSignal
): Promise<{ transport: MultiplexerTransport; nodePath: string; sockPath: string }> {
  // Why: graceTimeSeconds comes from user-editable SshTarget config; floor+clamp to an integer prevents shell injection if the type ever loosened.
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
  // Why: remoteRelayDir is shared across Orca targets for one account; hashing the target ID into the socket name stops cross-target attach.
  const sockName = relaySocketNameForInstanceId(relayInstanceId)
  const sockFile = relayEndpointForHost(hostPlatform, remoteDir, sockName)
  const endpointDir = relayHookEndpointDirForHost(hostPlatform, remoteDir, sockFile)

  if (isWindowsRemoteHost(hostPlatform)) {
    const activePipeMarkerPath = windowsActivePipeMarkerPath(hostPlatform, remoteDir, sockName)
    const activeEndpoint = (await readWindowsActiveRelayEndpoint(
      conn,
      hostPlatform,
      remoteDir,
      activePipeMarkerPath,
      signal
    )) ?? {
      sockPath: sockFile,
      endpointDir
    }
    const fallbackEndpoint = buildWindowsRelayFallbackEndpoint(hostPlatform, remoteDir, sockName)
    return launchWindowsRelay(
      conn,
      hostPlatform,
      {
        remoteDir,
        nodePath,
        sockPath: activeEndpoint.sockPath,
        endpointDir: activeEndpoint.endpointDir,
        graceTime,
        activePipeMarkerPath,
        reconnectFallback: fallbackEndpoint
      },
      signal
    )
  }

  // Why: after a restart the relay may still be alive in its grace period; --connect to its socket preserves PTY state and scrollback.
  try {
    const probeOutput = await execCommand(
      conn,
      `test -S ${shellEscape(sockFile)} && echo ALIVE || echo DEAD`,
      { signal }
    )
    console.warn(`[ssh-relay] Socket probe result: "${probeOutput.trim()}"`)
    if (probeOutput.trim() === 'ALIVE') {
      console.log('[ssh-relay] Existing relay socket found, attempting reconnect...')
      try {
        const channel = await conn.exec(
          `cd ${escapedDir} && ${escapedNode} relay.js --connect --sock-path ${shellEscape(sockFile)}`,
          { signal }
        )
        const transport = await waitForSentinel(channel, signal)
        console.log('[ssh-relay] Reconnected to existing relay via socket')
        return { transport, nodePath, sockPath: sockFile }
      } catch (err) {
        signal?.throwIfAborted()
        console.warn(
          '[ssh-relay] Socket reconnect failed, launching fresh relay:',
          err instanceof Error ? err.message : String(err)
        )
        // Why: stale socket from a crashed relay — remove it so the fresh launch can bind at the same path.
        await execCommand(conn, `rm -f ${shellEscape(sockFile)}`, { signal }).catch(
          (cleanupErr) => {
            if (isUnconfirmedSshCommandTermination(cleanupErr)) {
              throw cleanupErr
            }
          }
        )
        signal?.throwIfAborted()
      }
    }
  } catch (err) {
    if (isUnconfirmedSshCommandTermination(err)) {
      throw err
    }
    signal?.throwIfAborted()
    // Probe failed — fall through to fresh launch
  }

  // Why: relay must outlive the SSH connection so PTY sessions survive app restarts — nohup + </dev/null + & detach it from the exec channel.
  // Why: execCommand would block on channel close that backgrounded children never allow; fire-and-forget via conn.exec, the socket poll detects readiness.
  const logFile = `${remoteDir}/relay.log`
  // Why: --log-file lets the relay rotate relay.log in-process; the shell redirect stays to capture pre-JS boot/crash output.
  const launchCmd = `cd ${escapedDir} && nohup ${escapedNode} relay.js --detached --grace-time ${graceTime} --sock-path ${shellEscape(sockFile)} --log-file ${shellEscape(logFile)} > ${shellEscape(logFile)} 2>&1 </dev/null &`
  const launchChannel = await conn.exec(launchCmd, { signal })
  launchChannel.on('data', () => {})
  launchChannel.on('error', () => {})
  launchChannel.stderr.on('data', () => {})
  launchChannel.stderr.on('error', () => {})
  // Why: the SSH channel stays open until all child fds close; close it after the poll or channels accumulate and hit the server's MaxSessions limit.
  launchChannel.on('close', () => {})

  // Why: poll rather than fixed sleep — remote host speed varies widely (CI vs. Raspberry Pi).
  // Why: test -S only proves the inode exists, not that the relay is listening; a connect-and-close confirms it accepts connections.
  const POLL_INTERVAL_MS = 200
  const POLL_TIMEOUT_MS = 10_000
  const pollStart = Date.now()
  let socketReady = false
  try {
    while (Date.now() - pollStart < POLL_TIMEOUT_MS) {
      try {
        // Why: probe via node (guaranteed present) not python3/socat/perl; pass the socket path as argv[1] to dodge -e quoting issues.
        const result = await execCommand(
          conn,
          `${escapedNode} -e 'var s=require("net").connect(process.argv[1]);s.on("connect",function(){s.destroy();process.stdout.write("READY")});s.on("error",function(){process.stdout.write("WAITING")})' ${shellEscape(sockFile)} 2>/dev/null || (test -S ${shellEscape(sockFile)} && echo READY || echo WAITING)`,
          { signal }
        )
        if (result.trim() === 'READY') {
          socketReady = true
          break
        }
      } catch {
        signal?.throwIfAborted()
        /* exec failed, retry */
      }
      await waitForRelayPoll(POLL_INTERVAL_MS, signal)
    }
  } finally {
    launchChannel.close()
  }

  if (!socketReady) {
    const logOutput = await execCommand(
      conn,
      `tail -20 ${shellEscape(logFile)} 2>/dev/null || echo "(no log)"`,
      { signal }
    ).catch(() => '(could not read log)')
    signal?.throwIfAborted()
    throw new Error(`Relay failed to start within ${POLL_TIMEOUT_MS / 1000}s. Log:\n${logOutput}`)
  }

  // Why: backgrounded relay's stdout goes to a log file, not the exec channel; --connect bridges this channel to its Unix socket.
  const channel = await conn.exec(
    `cd ${escapedDir} && ${escapedNode} relay.js --connect --sock-path ${shellEscape(sockFile)}`,
    { signal }
  )
  return { transport: await waitForSentinel(channel, signal), nodePath, sockPath: sockFile }
}

function waitForRelayPoll(delayMs: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timeout)
      signal?.removeEventListener('abort', onAbort)
      reject(createSshOperationAbortError())
    }
    const timeout = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, delayMs)
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) {
      onAbort()
    }
  })
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
  markerPath: string,
  signal?: AbortSignal
): Promise<WindowsRelayEndpoint | null> {
  const output = await execHostCommand(
    conn,
    hostPlatform,
    powerShellCommand(
      `if (Test-Path -LiteralPath ${powerShellLiteral(markerPath)} -PathType Leaf) { Get-Content -LiteralPath ${powerShellLiteral(markerPath)} -Raw -ErrorAction SilentlyContinue }`
    ),
    { signal }
  ).catch(() => {
    signal?.throwIfAborted()
    return ''
  })
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
  sockPath: string,
  signal?: AbortSignal
): Promise<void> {
  await execHostCommand(
    conn,
    hostPlatform,
    powerShellCommand(
      `Set-Content -LiteralPath ${powerShellLiteral(markerPath)} -Value ${powerShellLiteral(sockPath)} -NoNewline`
    ),
    { signal }
  ).catch((err) => {
    signal?.throwIfAborted()
    // Why: fallback pipe names are deterministic, so losing this marker won't orphan an undiscoverable relay.
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
  opts: WindowsRelayLaunchOptions,
  signal?: AbortSignal
): Promise<{ transport: MultiplexerTransport; nodePath: string; sockPath: string }> {
  let launchOpts = opts
  if ((await probeWindowsRelayPipe(conn, hostPlatform, opts, signal)) === 'READY') {
    try {
      const transport = await connectWindowsRelay(conn, hostPlatform, opts, signal)
      await rememberWindowsActiveRelayEndpoint(
        conn,
        hostPlatform,
        opts.activePipeMarkerPath,
        opts.sockPath,
        signal
      )
      return {
        transport,
        nodePath: opts.nodePath,
        sockPath: opts.sockPath
      }
    } catch (err) {
      signal?.throwIfAborted()
      console.warn(
        '[ssh-relay] Windows named pipe reconnect failed, launching fresh relay:',
        err instanceof Error ? err.message : String(err)
      )
      if (opts.reconnectFallback) {
        // Why: a Windows named pipe can't be unlinked like a Unix socket; a deterministic fallback pipe keeps the next deploy recoverable.
        // Why: spread keeps activePipeMarkerPath at the original target sock name — the marker records that target's active pipe, fallback or not.
        launchOpts = { ...opts, ...opts.reconnectFallback }
      }
    }
  }

  if (
    launchOpts !== opts &&
    (await probeWindowsRelayPipe(conn, hostPlatform, launchOpts, signal)) === 'READY'
  ) {
    try {
      const transport = await connectWindowsRelay(conn, hostPlatform, launchOpts, signal)
      await rememberWindowsActiveRelayEndpoint(
        conn,
        hostPlatform,
        launchOpts.activePipeMarkerPath,
        launchOpts.sockPath,
        signal
      )
      return {
        transport,
        nodePath: launchOpts.nodePath,
        sockPath: launchOpts.sockPath
      }
    } catch (err) {
      signal?.throwIfAborted()
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
    ),
    { signal }
  )

  const POLL_INTERVAL_MS = 200
  const POLL_TIMEOUT_MS = 10_000
  if (
    await waitForWindowsRelayPipe(
      conn,
      hostPlatform,
      launchOpts,
      POLL_TIMEOUT_MS,
      POLL_INTERVAL_MS,
      signal
    )
  ) {
    const transport = await connectWindowsRelay(conn, hostPlatform, launchOpts, signal)
    await rememberWindowsActiveRelayEndpoint(
      conn,
      hostPlatform,
      launchOpts.activePipeMarkerPath,
      launchOpts.sockPath,
      signal
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
    windowsRelayTailLogCommand(logFile, errFile),
    { signal }
  ).catch(() => {
    signal?.throwIfAborted()
    return '(could not read log)'
  })
  throw new Error(`Relay failed to start within ${POLL_TIMEOUT_MS / 1000}s. Log:\n${logOutput}`)
}

async function connectWindowsRelay(
  conn: SshConnection,
  hostPlatform: RemoteHostPlatform,
  opts: {
    remoteDir: string
    nodePath: string
    sockPath: string
  },
  signal?: AbortSignal
): Promise<MultiplexerTransport> {
  const channel = await conn.exec(
    windowsRelayConnectCommand(hostPlatform, opts.nodePath, opts.remoteDir, opts.sockPath),
    { wrapCommand: false, signal }
  )
  return waitForSentinel(channel, signal)
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
  // Why: Windows sshd kills the exec channel's process tree on close; WMI re-parents the detached relay to survive.
  const quoted = (value: string): string => `"${value.replace(/"/g, '\\"')}"`
  const relayCommandLine = [
    quoted(nodePath),
    quoted(relayScript),
    '--detached',
    '--grace-time',
    String(graceTime),
    '--sock-path',
    quoted(sockPath),
    '--endpoint-dir',
    quoted(endpointDir),
    // Why: --log-file owns rotation; shell redirects still capture pre-JS boot/crash output.
    '--log-file',
    quoted(logFile),
    `1>${quoted(logFile)}`,
    `2>${quoted(errFile)}`
  ].join(' ')
  const wmiCommandLine = `cmd.exe /d /s /c "${relayCommandLine}"`
  return commandWithNodePath(
    hostPlatform,
    nodePath,
    remoteDir,
    [
      `$result = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = ${powerShellLiteral(wmiCommandLine)}; CurrentDirectory = ${powerShellLiteral(remoteDir)} }`,
      `if ($result.ReturnValue -ne 0) { throw "Win32_Process.Create failed with $($result.ReturnValue)" }`
    ].join('; ')
  )
}

async function probeWindowsRelayPipe(
  conn: SshConnection,
  hostPlatform: RemoteHostPlatform,
  opts: {
    remoteDir: string
    nodePath: string
    sockPath: string
  },
  signal?: AbortSignal
): Promise<'READY' | 'WAITING'> {
  const result = await execHostCommand(
    conn,
    hostPlatform,
    windowsRelayProbeCommand(hostPlatform, opts.nodePath, opts.remoteDir, opts.sockPath),
    { signal }
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
  intervalMs: number,
  signal?: AbortSignal
): Promise<boolean> {
  try {
    const result = await execHostCommand(
      conn,
      hostPlatform,
      windowsRelayWaitCommand(hostPlatform, opts.nodePath, opts.remoteDir, opts.sockPath, {
        timeoutMs,
        intervalMs
      }),
      { signal }
    )
    return result.trim() === 'READY'
  } catch {
    signal?.throwIfAborted()
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
    `& ${powerShellLiteral(nodePath)} -e ${powerShellNativeArg(js)} ${powerShellNativeArg(sockPath)}`
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
      powerShellNativeArg(js),
      powerShellNativeArg(sockPath),
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
