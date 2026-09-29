/* eslint-disable max-lines -- Why: one cohesive contract (version detect, install-locked deploy, native-deps probe, launch, GC); splitting risks install/GC drift. */
import { existsSync } from 'node:fs'
import { app } from 'electron'
import { relayBundleCandidates } from './relay-bundle-paths'
import type { SshConnection } from './ssh-connection'
import { RELAY_REMOTE_DIR, type RelayPlatform } from './relay-protocol'
import type { MultiplexerTransport } from './ssh-channel-multiplexer'
import {
  waitForSentinel,
  execCommand,
  isUnconfirmedSshCommandTermination
} from './ssh-relay-deploy-helpers'
import { uploadRelayDirectory, writeRelayFile } from './ssh-relay-install-transfers'
import {
  createRelayInstallMarkerCommand,
  createRelayInstallNamespace,
  createRelayUploadStageNamespace,
  makeRelayInstallDirectoryCommand,
  relayHomeRelativeDir,
  relayUploadStageSftpNamespaceMapping,
  type RelayInstallNamespace,
  type RelayUploadStageNamespace
} from './ssh-relay-install-namespace'
import { createRelayInstallMarkerFileName } from './ssh-relay-install-marker'
import { ensureRemoteRelayBunRuntime } from './ssh-relay-bun-runtime'
import { installRelayBunDependencies, RELAY_BUN_NATIVE_DEPS } from './ssh-relay-bun-dependencies'
import {
  ensureRemoteBundledRipgrep,
  remoteRipgrepLayout,
  recordRemoteRipgrepReference
} from './ssh-relay-ripgrep-install'
import { gcRemoteRipgrepCache } from './ssh-relay-ripgrep-cache-gc'
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
import {
  RELAY_DEPLOY_TEARDOWN_TIMEOUT_MS,
  RELAY_DEPLOY_TIMEOUT_MS
} from './ssh-relay-deploy-timing'
import { createSshOperationAbortError, shellEscape } from './ssh-connection-utils'
import {
  commandInRemoteDirectory,
  commandWithNodePath,
  readRemoteHomeCommand
} from './ssh-remote-commands'
import {
  cleanupOwnedRelayUploadStageCommand,
  parseReservedRelayUploadStage,
  promoteOwnedRelayUploadStageCommand,
  recoverOneStaleRelayUploadStageCommand,
  relayUploadStagePromotionConfirmed,
  RELAY_UPLOAD_STAGE_POOL_NAME,
  reserveRelayUploadStageCommand
} from './ssh-relay-upload-stage-commands'
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
import { resolveRelayEndpointBeforeRelaunch } from './ssh-relay-endpoint-takeover'
import {
  RelayProbeCleanupUnconfirmedError,
  isRelayEndpointHeldError,
  isRelayEndpointUnresponsiveError
} from './ssh-relay-endpoint-incumbent'
import { sweepSupersededRelayEndpoints } from './ssh-relay-superseded-endpoints'
import {
  parseShortRelaySocketDir,
  remoteSocketPathFitsLimit,
  resolveShortRelaySocketDirCommand,
  shortRelaySocketPath,
  shortRelayVersionSegment,
  SHORT_RELAY_SOCKET_DIR_PREFIX
} from './relay-socket-path-limit'
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
  serverBuildId?: string
  platform: RelayPlatform
  hostPlatform?: RemoteHostPlatform
  remoteHome?: string
  remoteRelayDir?: string
  nodePath?: string
  sockPath?: string
  credentialFile?: string
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
  options?: { timeoutMs?: number; signal?: AbortSignal; onStderr?: (stderr: string) => void }
): Promise<string> {
  return execCommand(conn, command, {
    wrapCommand: !isWindowsRemoteHost(hostPlatform),
    timeoutMs: options?.timeoutMs,
    signal: options?.signal,
    onStderr: options?.onStderr
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
  const deployAbortController = new AbortController()
  const timedOut = Symbol('relay-deploy-timeout')
  const deployment = deployAndLaunchRelayInner(
    conn,
    onProgress,
    graceTimeSeconds,
    relayInstanceId,
    deployAbortController.signal
  ).then(
    (result) => ({ status: 'fulfilled' as const, result }),
    (error: unknown) => ({ status: 'rejected' as const, error })
  )
  const timeoutPromise = new Promise<typeof timedOut>((resolve) => {
    timeoutHandle = setTimeout(() => {
      deployAbortController.abort()
      resolve(timedOut)
    }, RELAY_DEPLOY_TIMEOUT_MS)
  })

  try {
    const outcome = await Promise.race([deployment, timeoutPromise])
    if (outcome !== timedOut) {
      if (outcome.status === 'fulfilled') {
        return outcome.result
      }
      throw outcome.error
    }

    const teardownExpired = Symbol('relay-deploy-teardown-timeout')
    let teardownTimeoutHandle: ReturnType<typeof setTimeout>
    const teardown = await Promise.race([
      deployment,
      new Promise<typeof teardownExpired>((resolve) => {
        teardownTimeoutHandle = setTimeout(
          () => resolve(teardownExpired),
          RELAY_DEPLOY_TEARDOWN_TIMEOUT_MS
        )
      })
    ]).finally(() => clearTimeout(teardownTimeoutHandle!))
    const timeoutError = Object.assign(
      new Error(`Relay deployment timed out after ${RELAY_DEPLOY_TIMEOUT_MS / 1000}s`),
      teardownConfirmation(teardown === teardownExpired ? undefined : teardown)
    )
    throw timeoutError
  } finally {
    clearTimeout(timeoutHandle!)
  }
}

function teardownConfirmation(
  outcome:
    | { status: 'fulfilled'; result: RelayDeployResult }
    | { status: 'rejected'; error: unknown }
    | undefined
): { sshChannelCloseConfirmed: boolean; sshTransferTeardownConfirmed: boolean } {
  if (!outcome) {
    return { sshChannelCloseConfirmed: false, sshTransferTeardownConfirmed: false }
  }
  if (outcome.status === 'fulfilled') {
    return { sshChannelCloseConfirmed: true, sshTransferTeardownConfirmed: true }
  }
  const error = outcome.error as {
    sshChannelCloseConfirmed?: unknown
    sshTransferTeardownConfirmed?: unknown
  }
  return {
    sshChannelCloseConfirmed: error?.sshChannelCloseConfirmed === true,
    sshTransferTeardownConfirmed: error?.sshTransferTeardownConfirmed === true
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

async function resolveRelayBootstrapState(
  conn: SshConnection,
  hostPlatform: RemoteHostPlatform,
  fullVersion: string,
  signal?: AbortSignal
): Promise<RelayBootstrapState> {
  const installState = await resolveRemoteInstallState(conn, hostPlatform, fullVersion, { signal })
  const nodePath = await ensureRemoteRelayBunRuntime(conn, hostPlatform, installState.remoteHome, {
    signal
  })
  return { ...installState, nodePath }
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
  // Resolve the host home before staging the pinned runtime; no host Node probe is needed.
  const { remoteHome, remoteRelayDir, alreadyInstalled, nodePath } =
    await resolveRelayBootstrapState(conn, hostPlatform, fullVersion, deploySignal)
  console.log(`[ssh-relay] Remote dir: ${remoteRelayDir}`)
  console.log(`[ssh-relay] Already installed at ${fullVersion}: ${alreadyInstalled}`)

  // Why: derive the home-relative suffix once — recomputing it by stripping the shell home breaks on a split namespace.
  const homeRelativeRelayDir = relayHomeRelativeDir(fullVersion)
  const uploadStagePoolDir = joinRemotePath(
    hostPlatform,
    remoteHome,
    RELAY_REMOTE_DIR,
    RELAY_UPLOAD_STAGE_POOL_NAME
  )
  const homeRelativeUploadStagePoolDir = `${RELAY_REMOTE_DIR}/${RELAY_UPLOAD_STAGE_POOL_NAME}`

  let ownsInstallLock = false
  let launchGcClaimToken: string | undefined
  let launchNamespace: RelayInstallNamespace | undefined
  if (alreadyInstalled) {
    const launchFence = await repairInstalledNativeDeps(
      conn,
      remoteRelayDir,
      hostPlatform,
      nodePath,
      homeRelativeRelayDir,
      deploySignal
    )
    ownsInstallLock = launchFence.ownsInstallLock
    launchGcClaimToken = launchFence.gcClaimToken
    launchNamespace = launchFence.sftpNamespace
    deploySignal?.throwIfAborted()
  } else {
    await execHostCommand(
      conn,
      hostPlatform,
      recoverOneStaleRelayUploadStageCommand(hostPlatform, uploadStagePoolDir),
      { signal: deploySignal }
    )
    const uploadStageOwner = createRelayInstallMarkerFileName()
    const reservation = await execHostCommand(
      conn,
      hostPlatform,
      reserveRelayUploadStageCommand(hostPlatform, uploadStagePoolDir, uploadStageOwner),
      { signal: deploySignal }
    )
    const uploadStage = parseReservedRelayUploadStage(
      hostPlatform,
      uploadStagePoolDir,
      uploadStageOwner,
      reservation
    )
    const uploadStagePayloadDir = joinRemotePath(hostPlatform, uploadStage.slotDir, 'payload')
    const uploadStageNamespace = createRelayUploadStageNamespace(
      `${homeRelativeUploadStagePoolDir}/${uploadStage.slotName}`,
      uploadStageOwner
    )
    const uploadStageSftpNamespace = uploadStageNamespaceIfSupported(
      conn,
      hostPlatform,
      uploadStageNamespace
    )
    let uploadStageCleanupAllowed = true
    onProgress?.('Uploading relay...')
    console.log('[ssh-relay] Uploading relay...')
    try {
      await uploadRelay(
        conn,
        platform,
        uploadStagePayloadDir,
        fullVersion,
        hostPlatform,
        deploySignal,
        { rootDir: uploadStage.slotDir, namespace: uploadStageSftpNamespace }
      )

      await acquireInstallLock(conn, remoteRelayDir, hostPlatform, { signal: deploySignal })
      ownsInstallLock = true
      try {
        // Re-probe after acquiring the lock — a sibling installer may have finished while we waited.
        if (
          !(await isRelayAlreadyInstalled(conn, remoteRelayDir, hostPlatform, {
            signal: deploySignal
          }))
        ) {
          launchNamespace = await createRelayLaunchNamespace(
            conn,
            hostPlatform,
            remoteRelayDir,
            homeRelativeRelayDir,
            deploySignal
          )
          const promotion = await execHostCommand(
            conn,
            hostPlatform,
            promoteOwnedRelayUploadStageCommand(
              hostPlatform,
              uploadStage,
              uploadStageOwner,
              remoteRelayDir
            ),
            { signal: deploySignal }
          )
          if (!relayUploadStagePromotionConfirmed(uploadStageOwner, promotion)) {
            throw new Error('Relay upload stage ownership was lost before promotion')
          }
          console.log('[ssh-relay] Upload complete')

          onProgress?.('Installing native dependencies...')
          console.log('[ssh-relay] Installing native dependencies...')
          await installRelayBunDependencies({
            conn,
            directory: remoteRelayDir,
            host: hostPlatform,
            runtime: nodePath,
            signal: deploySignal,
            namespace: launchNamespace
          })
          console.log('[ssh-relay] Native deps installed')

          // Why: mark complete but retain the lock until launch makes daemon liveness observable to cross-version GC.
          await finalizeInstall(conn, remoteRelayDir, hostPlatform, {
            signal: deploySignal,
            releaseLock: false
          })
        }
      } catch (err) {
        if (!isUnconfirmedSshCommandTermination(err)) {
          await abandonInstall(conn, remoteRelayDir, hostPlatform)
          ownsInstallLock = false
        }
        throw err
      }
    } catch (error) {
      uploadStageCleanupAllowed = !isUnconfirmedSshCommandTermination(error)
      throw error
    } finally {
      if (uploadStageCleanupAllowed) {
        await execHostCommand(
          conn,
          hostPlatform,
          cleanupOwnedRelayUploadStageCommand(hostPlatform, uploadStage, uploadStageOwner)
        ).catch((error) => {
          if (isUnconfirmedSshCommandTermination(error)) {
            throw error
          }
        })
      }
    }
  }

  const ripgrepLayout = remoteRipgrepLayout(hostPlatform, remoteHome)
  const ripgrepReferenced =
    ripgrepLayout &&
    (await recordRemoteRipgrepReference(
      conn,
      hostPlatform,
      remoteRelayDir,
      ripgrepLayout.entryName
    ))
  deploySignal?.throwIfAborted()
  onProgress?.('Starting relay...')
  console.log('[ssh-relay] Launching relay...')
  // A failed launch retains its fences until stale recovery can establish liveness.
  const launched = await launchRelay(
    conn,
    remoteRelayDir,
    hostPlatform,
    nodePath,
    graceTimeSeconds,
    relayInstanceId,
    deploySignal,
    ripgrepReferenced ? ripgrepLayout.binaryPath : undefined
  )
  let launchCleanupSettled = true
  try {
    if (ownsInstallLock) {
      await abandonInstall(conn, remoteRelayDir, hostPlatform)
    }
    if (launchGcClaimToken) {
      await releaseRelayGcClaimWithRetry(conn, remoteRelayDir, launchGcClaimToken, hostPlatform)
    }
  } catch (error) {
    // Keep the connected transport, but stop optional commands after uncertain fence release.
    launchCleanupSettled = !isUnconfirmedSshCommandTermination(error)
    console.warn('[ssh-relay] Launch fence release failed:', error)
  }
  console.log('[ssh-relay] Relay started successfully')

  // Keep background commands serial for SSH transports that allow only one exec at a time.
  const ripgrepEntry = ripgrepLayout?.entryName
  const ripgrepInstall = (
    ripgrepReferenced && launchCleanupSettled
      ? ensureRemoteBundledRipgrep(conn, hostPlatform, remoteHome, { signal: deploySignal })
      : Promise.resolve()
  ).then(
    () => launchCleanupSettled,
    (error) => !isUnconfirmedSshCommandTermination(error)
  )
  void ripgrepInstall.then((ready) => {
    if (!ready) {
      return false
    }
    return (
      execHostCommand(
        conn,
        hostPlatform,
        recoverOneStaleRelayUploadStageCommand(hostPlatform, uploadStagePoolDir)
      )
        .catch((error) => {
          if (isUnconfirmedSshCommandTermination(error)) {
            throw error
          }
        })
        // Why before GC: a superseded relay pins its version dir via the live-socket probe, so the
        // sweep has to settle first or GC keeps every orphan's tree forever.
        .then(() =>
          sweepSupersededRelayEndpoints(conn, hostPlatform, {
            remoteHome,
            currentRelayDir: remoteRelayDir,
            sockName: relaySocketNameForInstanceId(relayInstanceId),
            // Set only when this launch relocated past sun_path; the sweep must not reap
            // the socket the transport it just handed back is talking to.
            ...(launched.sockPath.startsWith(SHORT_RELAY_SOCKET_DIR_PREFIX)
              ? {
                  currentShortSocketDir: launched.sockPath.slice(
                    0,
                    launched.sockPath.lastIndexOf('/')
                  )
                }
              : {}),
            nodePath: launched.nodePath
          })
        )
        .catch((error) => {
          if (
            error instanceof RelayProbeCleanupUnconfirmedError ||
            isUnconfirmedSshCommandTermination(error)
          ) {
            throw error
          }
        })
        .then(() =>
          gcOldRelayVersions(conn, remoteHome, remoteRelayDir, hostPlatform, {
            windowsNodePath: launched.nodePath,
            windowsSockNames: [relaySocketNameForInstanceId(relayInstanceId)]
          })
        )
        // Why after the version GC and not beside it: that pass is what removes the relay directories
        // holding the references, so running second is what lets a superseded build become collectable
        // in the same connect rather than the next one.
        .then(() =>
          gcRemoteRipgrepCache(conn, hostPlatform, remoteHome, { pinnedEntry: ripgrepEntry })
        )
        .then(() => true)
        .catch(
          (error) =>
            !(error instanceof RelayProbeCleanupUnconfirmedError) &&
            !isUnconfirmedSshCommandTermination(error)
        )
    )
  })

  return {
    transport: launched.transport,
    serverBuildId: fullVersion,
    platform,
    hostPlatform,
    remoteHome,
    remoteRelayDir,
    nodePath: launched.nodePath,
    sockPath: launched.sockPath,
    credentialFile: launched.credentialFile
  }
}

async function uploadRelay(
  conn: SshConnection,
  platform: RelayPlatform,
  remoteDir: string,
  fullVersion: string,
  hostPlatform: RemoteHostPlatform,
  signal?: AbortSignal,
  stage?: { rootDir: string; namespace?: RelayUploadStageNamespace }
): Promise<void> {
  const localRelayDir = getLocalRelayPath(platform)
  if (!localRelayDir || !existsSync(localRelayDir)) {
    throw new Error(
      `Relay package for ${platform} not found. Searched: ${getLocalRelayCandidates(platform).join(', ')}. ` +
        `This may be a packaging issue — try reinstalling Orca.`
    )
  }

  if (!stage) {
    await execHostCommand(
      conn,
      hostPlatform,
      makeRelayInstallDirectoryCommand(hostPlatform, remoteDir),
      { signal }
    )
  }

  await uploadRelayDirectory(conn, localRelayDir, remoteDir, hostPlatform, {
    signal,
    sftpNamespace: stage?.namespace
      ? relayUploadStageSftpNamespaceMapping(stage.namespace, hostPlatform, stage.rootDir)
      : undefined
  })

  // Why: write .version via SFTP not shell to avoid quoting content-hashed versions; the daemon reads it to validate the wire handshake.
  await writeRelayFile(
    conn,
    hostPlatform,
    joinRemotePath(hostPlatform, remoteDir, '.version'),
    fullVersion,
    {
      signal,
      sftpNamespace: stage?.namespace
        ? relayUploadStageSftpNamespaceMapping(
            stage.namespace,
            hostPlatform,
            stage.rootDir,
            '.version'
          )
        : undefined
    }
  )
}

/**
 * A marker is only meaningful where a split namespace can occur and where Orca
 * owns the SFTP session: POSIX hosts reached over the bundled ssh2 transport.
 */
function createInstallNamespaceIfSupported(
  conn: SshConnection,
  hostPlatform: RemoteHostPlatform,
  homeRelativeRelayDir: string
): RelayInstallNamespace | undefined {
  if (isWindowsRemoteHost(hostPlatform)) {
    return undefined
  }
  // A connection double without the transport accessor is an ssh2 connection.
  const usesSystemSsh =
    typeof conn.usesSystemSshTransport === 'function' ? conn.usesSystemSshTransport() : false
  return usesSystemSsh ? undefined : createRelayInstallNamespace(homeRelativeRelayDir)
}

function uploadStageNamespaceIfSupported(
  conn: SshConnection,
  hostPlatform: RemoteHostPlatform,
  namespace: RelayUploadStageNamespace
): RelayUploadStageNamespace | undefined {
  if (isWindowsRemoteHost(hostPlatform)) {
    return undefined
  }
  const usesSystemSsh =
    typeof conn.usesSystemSshTransport === 'function' ? conn.usesSystemSshTransport() : false
  return usesSystemSsh ? undefined : namespace
}

export const RELAY_NATIVE_DEPS = RELAY_BUN_NATIVE_DEPS

type RelayNativeDepName = keyof typeof RELAY_NATIVE_DEPS
const RELAY_NATIVE_DEP_NAMES = Object.keys(RELAY_NATIVE_DEPS) as RelayNativeDepName[]
const NATIVE_DEPS_MISSING_PREFIX = 'ORCA-NATIVE-DEPS-MISSING:'

function nativeDepsProbeJs(successToken: string, host: RemoteHostPlatform): string {
  const watcher = isWindowsRemoteHost(host) ? './parcel-watcher.node' : '@parcel/watcher'
  return `(()=>{if(!process.versions.bun||typeof Bun.Terminal!=="function")throw Error("Bundled Bun terminal support unavailable");try{require(${JSON.stringify(watcher)});console.log(${JSON.stringify(successToken)})}catch{console.log("${NATIVE_DEPS_MISSING_PREFIX}@parcel/watcher");process.exitCode=1}})()`
}

// Only named probe failures authorize repair; silence is not evidence of damage.
function missingNativeDepsFromProbe(output: string): RelayNativeDepName[] | undefined {
  const marker = output
    .split(/\r?\n/)
    .find((line) => line.trim().startsWith(NATIVE_DEPS_MISSING_PREFIX))
  if (!marker) {
    return undefined
  }
  const reported = marker.trim().slice(NATIVE_DEPS_MISSING_PREFIX.length).split(',')
  const named = RELAY_NATIVE_DEP_NAMES.filter((name) => reported.includes(name))
  return named.length > 0 ? named : undefined
}

type RelayNativeDepsProbeStatus = 'ok' | 'blocked' | 'unverifiable'

async function probeRequiredNativeDeps(
  conn: SshConnection,
  remoteDir: string,
  hostPlatform: RemoteHostPlatform,
  nodePath: string,
  signal?: AbortSignal
): Promise<{ status: RelayNativeDepsProbeStatus; missing: RelayNativeDepName[] }> {
  const escapedNode = shellEscape(nodePath)
  const probeJs = nativeDepsProbeJs('ORCA-NATIVE-DEPS-OK', hostPlatform)
  let probeStderr = ''
  try {
    const command = isWindowsRemoteHost(hostPlatform)
      ? commandWithNodePath(
          hostPlatform,
          nodePath,
          remoteDir,
          `try { & ${powerShellLiteral(nodePath)} --no-env-file --config=NUL --no-install -e ${powerShellNativeArg(probeJs)}; if ($LASTEXITCODE -ne 0) { 'MISSING' } } catch { 'MISSING' }`
        )
      : // Keep runtime startup errors separate from the probe verdict.
        commandWithNodePath(
          hostPlatform,
          nodePath,
          remoteDir,
          `(${escapedNode} --no-env-file --config=/dev/null --no-install -e ${shellEscape(probeJs)} || echo MISSING)`
        )
    const probe = await execHostCommand(conn, hostPlatform, command, {
      signal,
      onStderr: (text) => {
        probeStderr = text
      }
    })
    if (probe.includes('ORCA-NATIVE-DEPS-OK')) {
      return { status: 'ok', missing: [] }
    }
    const missing = missingNativeDepsFromProbe(probe)
    if (!missing) {
      console.warn(
        `[ssh-relay][NATIVE-DEPS-PROBE-UNPARSEABLE] Probe at ${remoteDir} answered without naming a dep; launching as-is. stdout=${probe.trim().slice(-200)} stderr=${probeStderr.trim().slice(-500)}`
      )
      return { status: 'unverifiable', missing: [] }
    }
    return { status: 'blocked', missing }
  } catch (error) {
    signal?.throwIfAborted()
    // Why: an unanswered probe says nothing about the deps; reporting MISSING here reset and
    // recompiled healthy relays, turning one dropped exec channel into a multi-minute reconnect.
    // Why: the wrongful rebuild was the only visible symptom, so without this line a dropped exec
    // channel leaves no trace at all.
    console.warn(
      `[ssh-relay] Native deps probe unanswered at ${remoteDir}; treating as unverifiable: ${
        error instanceof Error ? error.message : String(error)
      }`
    )
    return { status: 'unverifiable', missing: [] }
  }
}

async function repairInstalledNativeDeps(
  conn: SshConnection,
  remoteDir: string,
  hostPlatform: RemoteHostPlatform,
  nodePath: string,
  homeRelativeRelayDir: string,
  signal?: AbortSignal
): Promise<{
  ownsInstallLock: boolean
  gcClaimToken?: string
  sftpNamespace?: RelayInstallNamespace
}> {
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
      if (!isUnconfirmedSshCommandTermination(err)) {
        await abandonInstall(conn, remoteDir, hostPlatform)
      }
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
  // Why: only a probe that answered may trigger repair; an unverifiable one launches as-is and the next reconnect re-probes.
  if (initialProbe.status !== 'blocked') {
    // Why: even a healthy reconnect stays fenced until launch liveness is observable, or cross-version GC can rename after this probe.
    if (lockResult !== 'acquired') {
      return { ownsInstallLock: false, gcClaimToken }
    }
    try {
      return {
        ownsInstallLock: true,
        sftpNamespace: await createRelayLaunchNamespace(
          conn,
          hostPlatform,
          remoteDir,
          homeRelativeRelayDir,
          signal
        )
      }
    } catch (err) {
      signal?.throwIfAborted()
      console.warn(
        `[ssh-relay] Launch namespace marker is unconfirmed at ${remoteDir}; deferring lock ownership to stale recovery`
      )
      return { ownsInstallLock: !isUnconfirmedSshCommandTermination(err) }
    }
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
    let repairNamespace: RelayInstallNamespace | undefined
    if (probe.status !== 'ok') {
      // Why: the locked re-probe can only narrow the repair; when it can't answer, the initial probe's answered evidence still stands.
      const resetDeps = probe.status === 'unverifiable' ? initialProbe.missing : probe.missing
      // Why: only stamp ownership once the locked recheck proves this connection is the one about to write.
      repairNamespace = await createRelayLaunchNamespace(
        conn,
        hostPlatform,
        remoteDir,
        homeRelativeRelayDir,
        signal
      )
      await installRelayBunDependencies({
        conn,
        directory: remoteDir,
        host: hostPlatform,
        runtime: nodePath,
        signal,
        namespace: repairNamespace,
        repair: resetDeps.includes('@parcel/watcher')
      })
      await finalizeInstall(conn, remoteDir, hostPlatform, { signal, releaseLock: false })
    }
    return { ownsInstallLock: true, sftpNamespace: repairNamespace }
  } catch (err) {
    if (isUnconfirmedSshCommandTermination(err)) {
      throw err
    }
    // Why: hold a confirmed-failure lock through degraded launch so GC can't move the relay before liveness is visible.
    console.warn(
      `[ssh-relay] Native deps repair failed at ${remoteDir}; launching degraded: ${
        err instanceof Error ? err.message : String(err)
      }`
    )
    return { ownsInstallLock: true }
  }
}

/**
 * Stamp this connection as the launch writer while it owns the install lock.
 * Confirmed marker failures fall back to shell-path credential generation.
 */
async function createRelayLaunchNamespace(
  conn: SshConnection,
  hostPlatform: RemoteHostPlatform,
  remoteDir: string,
  homeRelativeRelayDir: string,
  signal?: AbortSignal
): Promise<RelayInstallNamespace | undefined> {
  const namespace = createInstallNamespaceIfSupported(conn, hostPlatform, homeRelativeRelayDir)
  if (!namespace) {
    return undefined
  }
  try {
    await execHostCommand(
      conn,
      hostPlatform,
      createRelayInstallMarkerCommand(namespace, hostPlatform, remoteDir),
      { signal }
    )
    return namespace
  } catch (err) {
    // Why: an unconfirmed termination still owes the caller its lock semantics; only a confirmed failure degrades to shell paths.
    if (isUnconfirmedSshCommandTermination(err)) {
      throw err
    }
    signal?.throwIfAborted()
    console.warn(
      `[ssh-relay] SFTP namespace marker unavailable at ${remoteDir}; retaining shell paths`
    )
    return undefined
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
    if (!isUnconfirmedSshCommandTermination(err)) {
      await releaseRelayGcClaimWithRetry(conn, remoteDir, token, hostPlatform)
    }
    throw err
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
  return relayBundleCandidates(platform, app.getAppPath())
}

async function launchRelay(
  conn: SshConnection,
  remoteDir: string,
  hostPlatform: RemoteHostPlatform,
  nodePath: string,
  graceTimeSeconds?: number,
  relayInstanceId?: string,
  signal?: AbortSignal,
  ripgrepPath?: string
): Promise<{
  transport: MultiplexerTransport
  nodePath: string
  sockPath: string
  credentialFile: string
}> {
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
  const defaultSockFile = relayEndpointForHost(hostPlatform, remoteDir, sockName)
  const endpointDir = relayHookEndpointDirForHost(hostPlatform, remoteDir, defaultSockFile)
  const credentialFile = joinRemotePath(hostPlatform, remoteDir, `${sockName}.credential`)
  // Why: a long remote $HOME pushes the default endpoint past sun_path and bind fails with a bare `listen EINVAL` (#10726).
  const sockFile = remoteSocketPathFitsLimit(hostPlatform, defaultSockFile)
    ? defaultSockFile
    : await resolveShortPosixRelaySocketPath(conn, remoteDir, sockName, defaultSockFile, signal)

  if (isWindowsRemoteHost(hostPlatform)) {
    const activePipeMarkerPath = windowsActivePipeMarkerPath(hostPlatform, remoteDir, sockName)
    const discoveredActiveEndpoint = await readWindowsActiveRelayEndpoint(
      conn,
      hostPlatform,
      remoteDir,
      activePipeMarkerPath,
      signal
    )
    const activeEndpoint = discoveredActiveEndpoint ?? {
      sockPath: sockFile,
      endpointDir
    }
    const fallbackEndpoint = buildWindowsRelayFallbackEndpoint(hostPlatform, remoteDir, sockName)
    const launched = await launchWindowsRelay(
      conn,
      hostPlatform,
      {
        remoteDir,
        nodePath,
        sockPath: activeEndpoint.sockPath,
        endpointDir: activeEndpoint.endpointDir,
        graceTime,
        activePipeMarkerPath,
        reconnectFallback: fallbackEndpoint,
        credentialFile,
        ripgrepPath
      },
      signal
    )
    return { ...launched, credentialFile }
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
          `cd ${escapedDir} && ${escapedNode} --no-env-file --config=/dev/null --no-install relay.js --connect --sock-path ${shellEscape(sockFile)} --credential-file ${shellEscape(credentialFile)}`,
          { signal }
        )
        const transport = await waitForSentinel(channel, signal)
        console.log('[ssh-relay] Reconnected to existing relay via socket')
        return { transport, nodePath, sockPath: sockFile, credentialFile }
      } catch (err) {
        signal?.throwIfAborted()
        console.warn(
          '[ssh-relay] Socket reconnect failed, establishing what owns the endpoint:',
          err instanceof Error ? err.message : String(err)
        )
        // Why not `rm -f`: unlinking does not close the listener the incumbent already holds,
        // so a refused --connect (version mismatch, rotated credential) used to leave a live
        // relay running forever with its PTYs while a replacement bound the same path (#8585).
        await resolveRelayEndpointBeforeRelaunch(conn, hostPlatform, nodePath, sockFile, err, {
          signal
        })
        signal?.throwIfAborted()
      }
    }
  } catch (err) {
    // Why rethrow the verdicts: this catch predates the incumbent probe and was meant for a failed
    // `test -S`. Swallowing a Held/Unresponsive verdict launches a fresh daemon over a live one —
    // the exact collision the probe exists to prevent (it lost the bind, but only by luck).
    if (
      err instanceof RelayProbeCleanupUnconfirmedError ||
      isUnconfirmedSshCommandTermination(err) ||
      isRelayEndpointHeldError(err) ||
      isRelayEndpointUnresponsiveError(err)
    ) {
      throw err
    }
    signal?.throwIfAborted()
    // Probe failed — fall through to fresh launch
  }

  // Why: relay must outlive the SSH connection so PTY sessions survive app restarts — nohup + </dev/null + & detach it from the exec channel.
  // Why: execCommand would block on channel close that backgrounded children never allow; fire-and-forget via conn.exec, the socket poll detects readiness.
  const logFile = `${remoteDir}/relay.log`
  // Why no credential write here: the daemon publishes it after it owns the socket. A launch
  // that loses the bind to a live relay then leaves the file — and every later --connect —
  // intact, where a client-side rewrite locked the survivor's clients out for good.
  // Why: --log-file lets the relay rotate relay.log in-process; the shell redirect stays to capture pre-JS boot/crash output.
  // Why: the relay derives its hook endpoint dir from the socket path; pin it back under the relay dir when the socket moved to /tmp.
  const endpointDirArg =
    sockFile === defaultSockFile ? '' : ` --endpoint-dir ${shellEscape(endpointDir)}`
  const ripgrepPathArg = ripgrepPath ? ` --ripgrep-path ${shellEscape(ripgrepPath)}` : ''
  const launchCmd = `cd ${escapedDir} && nohup ${escapedNode} --no-env-file --config=/dev/null --no-install relay.js --detached --grace-time ${graceTime} --sock-path ${shellEscape(sockFile)}${endpointDirArg} --credential-file ${shellEscape(credentialFile)} --log-file ${shellEscape(logFile)}${ripgrepPathArg} > ${shellEscape(logFile)} 2>&1 </dev/null &`
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
          `${escapedNode} --no-env-file --config=/dev/null --no-install -e 'var s=require("net").connect(process.argv[1]);s.on("connect",function(){s.destroy();process.stdout.write("READY")});s.on("error",function(){process.stdout.write("WAITING")})' ${shellEscape(sockFile)} 2>/dev/null || (test -S ${shellEscape(sockFile)} && echo READY || echo WAITING)`,
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
    `cd ${escapedDir} && ${escapedNode} --no-env-file --config=/dev/null --no-install relay.js --connect --sock-path ${shellEscape(sockFile)} --credential-file ${shellEscape(credentialFile)}`,
    { signal }
  )
  return {
    transport: await waitForSentinel(channel, signal),
    nodePath,
    sockPath: sockFile,
    credentialFile
  }
}

/**
 * Move the endpoint under a `$HOME`-independent base so its length is bounded.
 *
 * The hashed socket name is preserved in full: only the directory shrinks, so the
 * short form stays deterministic per target and cannot collide with another target.
 * The version directory's identity comes along as a hashed segment, so a later build
 * still binds a path of its own rather than the one its predecessor is holding.
 */
async function resolveShortPosixRelaySocketPath(
  conn: SshConnection,
  remoteDir: string,
  sockName: string,
  defaultSockFile: string,
  signal?: AbortSignal
): Promise<string> {
  const versionSegment = shortRelayVersionSegment(remoteDir.slice(remoteDir.lastIndexOf('/') + 1))
  const output = await execCommand(
    conn,
    resolveShortRelaySocketDirCommand(versionSegment, { sockName, originalPath: defaultSockFile }),
    {
      signal
    }
  ).catch((err: unknown) => {
    if (isUnconfirmedSshCommandTermination(err)) {
      throw err
    }
    signal?.throwIfAborted()
    return ''
  })
  const shortDir = parseShortRelaySocketDir(output, versionSegment)
  if (!shortDir) {
    throw new Error(
      `Relay socket path ${defaultSockFile} exceeds the remote Unix socket limit and no short socket directory could be created on the host.`
    )
  }
  const shortSockFile = shortRelaySocketPath(shortDir, sockName)
  console.warn(
    `[ssh-relay] Socket path too long for sun_path; using ${shortSockFile} instead of ${defaultSockFile}`
  )
  return shortSockFile
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
  credentialFile: string
  ripgrepPath?: string
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
  // Why no credential write: see launchRelay — the daemon publishes after it owns the pipe.
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
      errFile,
      launchOpts.credentialFile,
      launchOpts.ripgrepPath
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
    credentialFile: string
  },
  signal?: AbortSignal
): Promise<MultiplexerTransport> {
  const channel = await conn.exec(
    windowsRelayConnectCommand(
      hostPlatform,
      opts.nodePath,
      opts.remoteDir,
      opts.sockPath,
      opts.credentialFile
    ),
    { wrapCommand: false, signal }
  )
  return waitForSentinel(channel, signal)
}

function windowsRelayConnectCommand(
  hostPlatform: RemoteHostPlatform,
  nodePath: string,
  remoteDir: string,
  sockPath: string,
  credentialFile: string
): string {
  return commandWithNodePath(
    hostPlatform,
    nodePath,
    remoteDir,
    `& ${powerShellLiteral(nodePath)} --no-env-file --config=NUL --no-install relay.js --connect --sock-path ${powerShellLiteral(sockPath)} --credential-file ${powerShellLiteral(credentialFile)}`
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
  errFile: string,
  credentialFile: string,
  ripgrepPath?: string
): string {
  const relayScript = joinRemotePath(hostPlatform, remoteDir, 'relay.js')
  const provider = joinRemotePath(hostPlatform, remoteDir, 'conpty.dll')
  const args = [
    '--no-env-file',
    '--config=NUL',
    '--no-install',
    relayScript,
    '--spawn-detached',
    '--grace-time',
    String(graceTime),
    '--sock-path',
    sockPath,
    '--credential-file',
    credentialFile,
    '--endpoint-dir',
    endpointDir,
    '--log-file',
    logFile,
    '--launch-error-file',
    errFile,
    ...(ripgrepPath ? ['--ripgrep-path', ripgrepPath] : [])
  ]
  return commandInRemoteDirectory(
    hostPlatform,
    remoteDir,
    `$env:BUN_CONPTY_LIBRARY = ${powerShellLiteral(provider)}; & ${powerShellLiteral(nodePath)} ${args.map(powerShellLiteral).join(' ')}; if ($LASTEXITCODE -ne 0) { throw "Bun detached launch failed with exit $LASTEXITCODE" }`
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
    `& ${powerShellLiteral(nodePath)} --no-env-file --config=NUL --no-install -e ${powerShellNativeArg(js)} ${powerShellNativeArg(sockPath)}`
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
      '--no-env-file',
      '--config=NUL',
      '--no-install',
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
