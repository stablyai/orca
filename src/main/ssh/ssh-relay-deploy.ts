import { join } from 'node:path'
/* eslint-disable max-lines -- Why: one cohesive contract (version detect, install-locked deploy, native-deps probe, launch, GC); splitting risks install/GC drift. */
import { existsSync } from 'node:fs'
import { app } from 'electron'
import type { SshConnection } from './ssh-connection'
import { RELAY_REMOTE_DIR, type RelayPlatform } from './relay-protocol'
import type { MultiplexerTransport } from './ssh-channel-multiplexer'
import {
  waitForSentinel,
  execCommand,
  isUnconfirmedSshCommandTermination
} from './ssh-relay-deploy-helpers'
import { uploadRelayDirectory, writeRelayFile } from './ssh-relay-install-transfers'
import { writeRelayEndpointCredential } from './ssh-relay-endpoint-credential'
import {
  createRelayInstallMarkerCommand,
  createRelayInstallNamespace,
  createRelayUploadStageNamespace,
  makeRelayInstallDirectoryCommand,
  relayHomeRelativeDir,
  relaySftpNamespaceMapping,
  relayUploadStageSftpNamespaceMapping,
  type RelayInstallNamespace,
  type RelayUploadStageNamespace
} from './ssh-relay-install-namespace'
import { createRelayInstallMarkerFileName } from './ssh-relay-install-marker'
import { resolveRemoteNodePath } from './ssh-remote-node-resolution'
import {
  readLocalFullVersion,
  computeRemoteRelayDir,
  isRelayAlreadyInstalled,
  finalizeInstall,
  abandonInstall,
  gcOldRelayVersions
} from './ssh-relay-versioned-install'
import {
  attachRelayNativeDepsCache,
  promoteRelayNativeDepsCache,
  resolveRelayNativeDepsCacheKey,
  type RelayNativeDepsCacheContext
} from './ssh-relay-native-deps-cache-install'
import { acquireInstallLock } from './ssh-relay-install-lock'
import { tryAcquireRelayRepairLock } from './ssh-relay-repair-lock'
import {
  releaseRelayGcClaimWithRetry,
  tryAcquireRelayGcClaim,
  waitForRelayGcClaimRelease
} from './ssh-relay-gc-claim'
import {
  NATIVE_DEPS_COMMAND_TIMEOUT_MS,
  RELAY_DEPLOY_TEARDOWN_TIMEOUT_MS,
  RELAY_DEPLOY_TIMEOUT_MS
} from './ssh-relay-deploy-timing'
import { createSshOperationAbortError, shellEscape } from './ssh-connection-utils'
import {
  probeBuildToolchain,
  formatMissingToolchainError,
  formatSkippedNodePtyWarning,
  shouldProbeBuildToolchainAfterNativeDepsFailure
} from './ssh-relay-build-toolchain'
import {
  commandWithNodePath,
  makeRemoteExecutableCommand,
  readRemoteHomeCommand,
  removeRemoteFileCommand
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
import { sweepSupersededRelayEndpoints } from './ssh-relay-superseded-endpoints'
import {
  parseShortRelaySocketDir,
  remoteSocketPathFitsLimit,
  resolveShortRelaySocketDirCommand,
  shortRelaySocketPath,
  shortRelayVersionSegment,
  SHORT_RELAY_SOCKET_DIR_PREFIX
} from './relay-socket-path-limit'
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
      platform,
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
      } catch (err) {
        if (isUnconfirmedSshCommandTermination(err)) {
          uploadStageCleanupAllowed = false
        }
        throw err
      }

      try {
        await acquireInstallLock(conn, remoteRelayDir, hostPlatform, { signal: deploySignal })
        ownsInstallLock = true
      } catch (err) {
        if (isUnconfirmedSshCommandTermination(err)) {
          ownsInstallLock = true
        }
        throw err
      }
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
          try {
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
          } catch (err) {
            if (isUnconfirmedSshCommandTermination(err)) {
              uploadStageCleanupAllowed = false
            }
            throw err
          }
          console.log('[ssh-relay] Upload complete')

          onProgress?.('Installing native dependencies...')
          console.log('[ssh-relay] Installing native dependencies...')
          await installNativeDeps(
            conn,
            remoteRelayDir,
            platform,
            hostPlatform,
            nodePath,
            deploySignal,
            [],
            launchNamespace,
            remoteHome
          )
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
    } finally {
      if (uploadStageCleanupAllowed) {
        await execHostCommand(
          conn,
          hostPlatform,
          cleanupOwnedRelayUploadStageCommand(hostPlatform, uploadStage, uploadStageOwner)
        ).catch(() => {})
      }
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

  void execHostCommand(
    conn,
    hostPlatform,
    recoverOneStaleRelayUploadStageCommand(hostPlatform, uploadStagePoolDir)
  )
    .catch(() => {})
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
              currentShortSocketDir: launched.sockPath.slice(0, launched.sockPath.lastIndexOf('/'))
            }
          : {}),
        nodePath: launched.nodePath
      })
    )
    .catch(() => {})
    .then(() =>
      gcOldRelayVersions(conn, remoteHome, remoteRelayDir, hostPlatform, {
        windowsNodePath: launched.nodePath,
        windowsSockNames: [relaySocketNameForInstanceId(relayInstanceId)],
        // Why pin rather than rely on the symlink alone: a deploy that fell back to a
        // per-directory install has no reference to show, and its key must still survive.
        nativeDepsCacheKeys: [
          resolveRelayNativeDepsCacheKey({
            platform,
            localRelayDir,
            deps: RELAY_NATIVE_DEPS
          })
        ].filter((key): key is string => key !== null)
      })
    )
    .catch(() => {})

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

  if (!isWindowsRemoteHost(hostPlatform)) {
    await execHostCommand(
      conn,
      hostPlatform,
      makeRemoteExecutableCommand(hostPlatform, joinRemotePath(hostPlatform, remoteDir, 'node')),
      { signal }
    )
  }

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

const NODE_PTY_VERSION = '1.1.0'
const NODE_PTY_CONSOLE_LIST_PATCH_FILENAME = 'node-pty-1.1.0-console-list-agent-patch.cjs'
const NODE_PTY_MASTER_CLOEXEC_PATCH_FILENAME = 'node-pty-1.1.0-master-cloexec-patch.cjs'
const NODE_PTY_CLOEXEC_STATUS_PREFIX = 'ORCA-NPTY-CLOEXEC:'
/**
 * Whether the tree the patch left behind still leaks the pty master into every later child.
 * `fixed` is the only outcome a shared cache entry may be published from.
 */
type NodePtyMasterCloexecOutcome = 'fixed' | 'unfixed'
/**
 * The statuses that leave a non-leaking tree. Deliberately an allowlist, not a `failed:` denylist:
 * the script's `skipped:` family is mixed. `skipped:not-linux` is a platform that never leaks, but
 * `skipped:earlier-attempt-failed`, `skipped:no-compiled-build`, `skipped:unexpected-source` and
 * the two `skipped:<errno>` forms all mean the patch was refused and the leaky build is still on
 * disk -- indistinguishable from `failed:` as far as what gets published.
 */
const NODE_PTY_CLOEXEC_FIXED_STATUSES: ReadonlySet<string> = new Set([
  'patched',
  // The rebuild ran from patched source; only the isolation check could not observe the result.
  // An unobservable check is not a failed patch, and treating it as one would disable the shared
  // cache on every host without `lsof`.
  'patched-unverified',
  'already-patched',
  // Unreachable while the platform gate below short-circuits first, but it is the one `skipped:`
  // that means "nothing to fix" rather than "would not fix it".
  'skipped:not-linux'
])
// Exported for the relay-native-dependency-coverage test, which asserts every
// native addon the relay bundle imports is either installed here or explicitly
// declared as degrading without it.
export const RELAY_NATIVE_DEPS = {
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

/**
 * Which deps the probe *named* as unloadable, or `undefined` when the answer names none.
 *
 * Only the probe's own marker line is evidence about the deps. An answer without one (node never
 * ran, was killed, exited before the script) says nothing, so it must not be read as "all of them" —
 * that inference deleted both native modules on every reconnect of an affected host.
 */
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

/**
 * `ok` — the probe answered and both deps loaded. `blocked` — the probe answered with a marker
 * naming deps that failed to load. `unverifiable` — the probe never answered, or answered nothing
 * that names a dep; both are evidence about the probe, not about the deps.
 *
 * Why `unverifiable` is not `blocked`: repairing on it does `rm -rf node_modules/node-pty` and a
 * node-gyp source build (no Linux prebuild) against a relay that was never shown to be broken. An
 * unparseable answer is the worse half of that — it is deterministic and per-host, so a node that
 * cannot start (bad NODE_OPTIONS, OOM, exit 127) deleted both modules on every reconnect forever.
 * Same verdict discipline as `src/main/orcad/node-pty-precondition.ts` and
 * docs/reference/ssh-execution-boundary.md — loss of contact is not evidence.
 */
type RelayNativeDepsProbeStatus = 'ok' | 'blocked' | 'unverifiable'

async function probeRequiredNativeDeps(
  conn: SshConnection,
  remoteDir: string,
  hostPlatform: RemoteHostPlatform,
  nodePath: string,
  signal?: AbortSignal
): Promise<{ status: RelayNativeDepsProbeStatus; missing: RelayNativeDepName[] }> {
  const escapedNode = shellEscape(nodePath)
  const probeJs = nativeDepsProbeJs('ORCA-NATIVE-DEPS-OK')
  let probeStderr = ''
  try {
    const command = isWindowsRemoteHost(hostPlatform)
      ? commandWithNodePath(
          hostPlatform,
          nodePath,
          remoteDir,
          `try { & ${powerShellLiteral(nodePath)} -e ${powerShellNativeArg(probeJs)}; if ($LASTEXITCODE -ne 0) { 'MISSING' } } catch { 'MISSING' }`
        )
      : // Why: no `2>/dev/null` — it discarded the only line that says why node never reached the
        // script. stderr stays its own stream so it can't be mistaken for the verdict, mirroring
        // src/main/orcad/node-pty-precondition.ts.
        commandWithNodePath(
          hostPlatform,
          nodePath,
          remoteDir,
          `(${escapedNode} -e ${shellEscape(probeJs)} || echo MISSING)`
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
  platform: RelayPlatform,
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
      await installNativeDeps(
        conn,
        remoteDir,
        platform,
        hostPlatform,
        nodePath,
        signal,
        resetDeps,
        repairNamespace
      )
      await finalizeInstall(conn, remoteDir, hostPlatform, { signal, releaseLock: false })
    }
    return { ownsInstallLock: true, sftpNamespace: repairNamespace }
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
  resetDeps: RelayNativeDepName[] = [],
  namespace?: RelayInstallNamespace,
  remoteHome?: string
): Promise<void> {
  // Why a repair opts out: reset does `rm -rf node_modules/node-pty`, and through a shared
  // symlink that is every relay on the host losing its addon. Repairs detach and install
  // privately instead (the install command's own prefix drops the link).
  const localRelayDir = resetDeps.length === 0 && remoteHome ? getLocalRelayPath(platform) : null
  const cacheContext: RelayNativeDepsCacheContext | null =
    remoteHome && localRelayDir
      ? {
          hostPlatform,
          remoteHome,
          relayDir: remoteDir,
          platform,
          localRelayDir,
          deps: RELAY_NATIVE_DEPS,
          signal
        }
      : null
  const cache = cacheContext ? await attachRelayNativeDepsCache(conn, cacheContext) : null

  const writeRelayPackageJson = async (deps: Record<string, string>): Promise<void> => {
    await writeRelayFile(
      conn,
      hostPlatform,
      joinRemotePath(hostPlatform, remoteDir, 'package.json'),
      `${JSON.stringify({
        name: 'orca-relay',
        version: '1.0.0',
        private: true,
        type: 'commonjs',
        dependencies: deps,
        allowScripts: RELAY_NATIVE_DEP_SCRIPT_ALLOWLIST
      })}\n`,
      {
        signal,
        sftpNamespace: namespace
          ? relaySftpNamespaceMapping(namespace, hostPlatform, remoteDir, 'package.json')
          : undefined
      }
    )
  }

  // Why: node-pty's prebuild spawns `node` as a child, so node must be in PATH (commandWithNodePath) or it fails exit 127.
  // Why: npm init -y rejects '+' in content-hashed dir names, so write a fixed minimal package.json instead.
  // Why: type:commonjs pins module resolution against Node default flips or a remote ~/.npmrc type=module.
  await writeRelayPackageJson(RELAY_NATIVE_DEPS)

  if (cache?.mode === 'linked') {
    await makeNodePtySpawnHelperExecutable(conn, remoteDir, hostPlatform, signal)
    const linkedProbe = await probeInstalledNativeDeps(
      conn,
      remoteDir,
      hostPlatform,
      nodePath,
      signal
    )
    if (linkedProbe.available) {
      return
    }
    // Why fall through rather than repair the entry: it is shared, and something else on this
    // host may be running out of it right now. This directory installs its own copy instead.
    console.warn(
      `[ssh-relay][NATIVE-CACHE-UNUSABLE] shared entry ${cache.key} did not load at ${remoteDir} (${platform}); installing per-directory. stderr=${linkedProbe.stderr.trim().slice(-500)}`
    )
  }

  try {
    const installArgs = Object.entries(RELAY_NATIVE_DEPS)
      .map(([dep, version]) => shellEscape(`${dep}@${version}`))
      .join(' ')
    // Why: npm reports a present package as up to date even if a native file was deleted; reset only deps the probe found broken.
    const resetCommand = resetNativeDepsCommand(hostPlatform, resetDeps)
    const resetPrefix = `${detachSharedNativeDepsCommand(hostPlatform)}${resetCommand ? `${resetCommand}; ` : ''}`
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
        // Why: node-pty is the only dep that needs a compiler, and it only backs terminals. Retry
        // without it so files/git/editor still connect instead of failing the host outright; a
        // missing native dep is already non-fatal below. Rethrow the actionable error if even that
        // fails, so a host broken for some other reason still reports the toolchain gap.
        console.warn(
          `[ssh-relay][NPTY-SKIP-NO-TOOLCHAIN] ${remoteDir} (${platform}): ${formatSkippedNodePtyWarning(toolchain)}`
        )
        try {
          await installNativeDepsWithoutNodePty(
            conn,
            remoteDir,
            hostPlatform,
            nodePath,
            writeRelayPackageJson,
            resetDeps,
            signal
          )
        } catch (retryErr) {
          if (isUnconfirmedSshCommandTermination(retryErr)) {
            throw retryErr
          }
          signal?.throwIfAborted()
          // The thrown toolchain message is built from the original error, so log the retry's own
          // cause (registry, ENOSPC, EACCES) rather than losing it.
          console.warn(
            `[ssh-relay][NPTY-SKIP-RETRY-FAIL] node-pty-less reinstall failed at ${remoteDir} (${platform}): ${(retryErr as Error).message}`
          )
          throw new Error(formatMissingToolchainError(toolchain, msg), { cause: retryErr })
        }
        // Why: this early return skips the probe below, so verify the dep that does have a prebuilt —
        // a @parcel/watcher that installs but can't load would leave file watching silently dead.
        await warnIfWatcherUnloadableWithoutNodePty(
          conn,
          remoteDir,
          platform,
          hostPlatform,
          nodePath,
          signal
        )
        return
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

  // Why this precedes promotion: the patch renames `node-pty/build/Release`, runs `npm rebuild`
  // and rolls back inside `node_modules`, and promotion turns that directory into a symlink to a
  // published -- and by contract immutable -- shared cache entry. Patching afterwards would write
  // through the link, and `.deps-complete` would already have published an unpatched tree that
  // every later host links and skips.
  const cloexec = probe.available
    ? await applyNodePtyMasterCloexecPatch(
        conn,
        remoteDir,
        platform,
        hostPlatform,
        nodePath,
        signal
      )
    : 'unfixed'

  // Why promotion is gated on the probe and not on npm's exit code: an entry is shared, so the
  // only evidence worth publishing is this host having loaded both addons out of that tree.
  // Why it is gated on the patch too: a refused or rolled-back patch leaves the pre-patch leaky
  // build in place, and the cache key hashes this patch's bytes -- so publishing it would hand
  // every later host on the machine a tree that links, probes loadable, and skips patching.
  if (probe.available && cacheContext && cache) {
    if (cloexec === 'fixed') {
      await promoteRelayNativeDepsCache(conn, cacheContext, cache.key)
    } else {
      console.warn(
        `[ssh-relay][NPTY-CLOEXEC-UNSHARED] keeping the native deps at ${remoteDir} (${platform}) private; the tree still leaks the pty master, so it is not publishable as ${cache.key}`
      )
    }
  }

  // MISSING is non-fatal by design: the relay still serves fs/git/preflight; only native-backed ops fail on hosts that can't build the addons.
  if (!probe.available) {
    console.warn(
      `[ssh-relay][NPTY-MISSING] native deps installed but require() failed at ${remoteDir} (${platform}). stdout=${probe.output.trim().slice(-200)} stderr=${probe.stderr.trim().slice(-500)}`
    )
  }
}

/**
 * Re-apply the pty-master FD_CLOEXEC patch the app gets from pnpm to the host's npm copy (#17915).
 *
 * Why it is safe to rebuild under a live relay: this only runs from installNativeDeps, so only on a
 * freshly created directory or a locked repair, and a relay already serving PTYs has pty.node mapped
 * -- replacing the file on disk does not touch the running process. It keeps the build it started
 * with and picks up the patched one when it restarts.
 *
 * Why it is bounded: the remote script attempts the compile at most once per relay directory, and
 * the directory is content-hashed over the relay manifest -- so at most one compile per bundle.
 *
 * Why a shared cache entry never reaches here: the caller returns as soon as a linked tree probes
 * loadable, so this only ever rewrites a `node_modules` the relay directory still owns privately.
 *
 * Returns whether the tree that is left behind still leaks, which is what decides publishability.
 * The script exits 0 on every outcome by design, so the status line is the only evidence there is.
 */
async function applyNodePtyMasterCloexecPatch(
  conn: SshConnection,
  remoteDir: string,
  platform: RelayPlatform,
  hostPlatform: RemoteHostPlatform,
  nodePath: string,
  signal?: AbortSignal
): Promise<NodePtyMasterCloexecOutcome> {
  // Linux is the only relay platform that takes forkpty()'s no-O_CLOEXEC path; macOS and Windows
  // ship prebuilds, so forcing a rebuild there would add a first compile to fix nothing.
  if (isWindowsRemoteHost(hostPlatform) || !platform.startsWith('linux')) {
    return 'fixed'
  }
  try {
    const command = commandWithNodePath(
      hostPlatform,
      nodePath,
      remoteDir,
      `${shellEscape(nodePath)} ${shellEscape(NODE_PTY_MASTER_CLOEXEC_PATCH_FILENAME)} 2>&1`
    )
    const output = await execHostCommand(conn, hostPlatform, command, {
      timeoutMs: NATIVE_DEPS_COMMAND_TIMEOUT_MS,
      signal
    })
    const status =
      output
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find((line) => line.startsWith(NODE_PTY_CLOEXEC_STATUS_PREFIX))
        ?.slice(NODE_PTY_CLOEXEC_STATUS_PREFIX.length) ?? 'no-status'
    if (!NODE_PTY_CLOEXEC_FIXED_STATUSES.has(status)) {
      // Warn, not log: the script exits 0 on a refusal too, so this line is the only thing that
      // says the relay directory will leak a master into every child for its whole life.
      console.warn(
        `[ssh-relay][NPTY-CLOEXEC-UNFIXED] pty master still leaks at ${remoteDir} (${platform}): ${status}`
      )
      return 'unfixed'
    }
    console.log(`[ssh-relay][NPTY-CLOEXEC] ${remoteDir} (${platform}): ${status}`)
    return 'fixed'
  } catch (err) {
    signal?.throwIfAborted()
    // Never fatal: the script restores the working build itself, and a leaky relay beats none. An
    // interrupted rebuild leaves node-pty unloadable, which the existing repair path reinstalls.
    console.warn(
      `[ssh-relay][NPTY-CLOEXEC-FAIL] pty master cloexec patch failed at ${remoteDir} (${platform}): ${(err as Error).message}`
    )
    // An exec that never answered cannot say which build is on disk, and a tree nobody can vouch
    // for is exactly the one not to share.
    return 'unfixed'
  }
}

/**
 * Drop a shared-cache symlink before anything writes into `node_modules`.
 *
 * Why it prefixes every install rather than living in its own exec: `rm -rf node_modules/node-pty`
 * and `npm install` both follow the link, so a repair on one relay directory would otherwise
 * rewrite the tree every other relay on the host is running out of.
 */
function detachSharedNativeDepsCommand(hostPlatform: RemoteHostPlatform): string {
  if (isWindowsRemoteHost(hostPlatform)) {
    return ''
  }
  return 'if [ -L node_modules ]; then rm -f node_modules; fi; '
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

/**
 * Reinstall the relay's native deps with node-pty dropped, for hosts that cannot compile it.
 *
 * Why: npm reconciles every dependency in package.json, not just the ones named on the command
 * line, so node-pty has to leave the manifest too — naming only @parcel/watcher still rebuilds it.
 */
async function installNativeDepsWithoutNodePty(
  conn: SshConnection,
  remoteDir: string,
  hostPlatform: RemoteHostPlatform,
  nodePath: string,
  writeRelayPackageJson: (deps: Record<string, string>) => Promise<void>,
  resetDeps: RelayNativeDepName[],
  signal?: AbortSignal
): Promise<void> {
  const deps = Object.fromEntries(
    Object.entries(RELAY_NATIVE_DEPS).filter(([dep]) => dep !== 'node-pty')
  )
  await writeRelayPackageJson(deps)
  const installArgs = Object.entries(deps)
    .map(([dep, version]) => shellEscape(`${dep}@${version}`))
    .join(' ')
  // Why: the failed attempt leaves an unbuildable node-pty behind; clear it so npm prunes rather
  // than rebuilds it. Keep the caller's resets too — a repair reconnect still needs them.
  const resetCommand = resetNativeDepsCommand(hostPlatform, [
    ...new Set<RelayNativeDepName>([...resetDeps, 'node-pty'])
  ])
  // Why: POSIX-only command shape (`;` chaining, `2>&1`) — safe because the only caller is gated on a
  // linux platform. Widen that gate and this needs the Windows branch installNativeDeps already has.
  await execHostCommand(
    conn,
    hostPlatform,
    commandWithNodePath(
      hostPlatform,
      nodePath,
      remoteDir,
      `${detachSharedNativeDepsCommand(hostPlatform)}${resetCommand}; npm install --ignore-scripts=false --omit=dev --no-audit --no-fund ${installArgs} 2>&1`
    ),
    { timeoutMs: NATIVE_DEPS_COMMAND_TIMEOUT_MS, signal }
  )
}

/**
 * Report an unloadable @parcel/watcher after node-pty was skipped, without failing the connection.
 *
 * Why: node-pty is expected missing here, but a @parcel/watcher prebuilt that installs and still
 * can't require() (glibc below the floor — docs/reference/linux-glibc-compatibility.md) means dead
 * file watching. No rebuild: node-pty provably can't compile on this host, so it would only fail.
 */
async function warnIfWatcherUnloadableWithoutNodePty(
  conn: SshConnection,
  remoteDir: string,
  platform: RelayPlatform,
  hostPlatform: RemoteHostPlatform,
  nodePath: string,
  signal?: AbortSignal
): Promise<void> {
  try {
    const probe = await probeInstalledNativeDeps(conn, remoteDir, hostPlatform, nodePath, signal)
    if (probe.missing.includes('@parcel/watcher')) {
      console.warn(
        `[ssh-relay][WATCHER-MISSING-NPTY-SKIPPED] @parcel/watcher installed but require() failed at ${remoteDir} (${platform}); remote file watching is unavailable. stdout=${probe.output.trim().slice(-200)} stderr=${probe.stderr.trim().slice(-500)}`
      )
    }
  } catch (err) {
    if (isUnconfirmedSshCommandTermination(err)) {
      throw err
    }
    signal?.throwIfAborted()
    // Degraded-mode diagnostics must never cost the connection the retry just salvaged.
    console.warn(
      `[ssh-relay][WATCHER-PROBE-FAIL] native deps probe failed after skipping node-pty at ${remoteDir} (${platform}): ${(err as Error).message}`
    )
  }
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
    // A markerless answer names no dep, so it reports none; `available` already carries the failure.
    missing: probeOutput.includes(PROBE_OK) ? [] : (missingNativeDepsFromProbe(probeOutput) ?? []),
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
        credentialFile
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
          `cd ${escapedDir} && ${escapedNode} relay.js --connect --sock-path ${shellEscape(sockFile)} --credential-file ${shellEscape(credentialFile)}`,
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
    if (isUnconfirmedSshCommandTermination(err)) {
      throw err
    }
    signal?.throwIfAborted()
    // Probe failed — fall through to fresh launch
  }

  // Why: relay must outlive the SSH connection so PTY sessions survive app restarts — nohup + </dev/null + & detach it from the exec channel.
  // Why: execCommand would block on channel close that backgrounded children never allow; fire-and-forget via conn.exec, the socket poll detects readiness.
  const logFile = `${remoteDir}/relay.log`
  await writeRelayEndpointCredential(conn, hostPlatform, nodePath, credentialFile, {
    signal
  })
  // Why: --log-file lets the relay rotate relay.log in-process; the shell redirect stays to capture pre-JS boot/crash output.
  // Why: the relay derives its hook endpoint dir from the socket path; pin it back under the relay dir when the socket moved to /tmp.
  const endpointDirArg =
    sockFile === defaultSockFile ? '' : ` --endpoint-dir ${shellEscape(endpointDir)}`
  const launchCmd = `cd ${escapedDir} && chmod 600 ${shellEscape(credentialFile)} && nohup ${escapedNode} relay.js --detached --grace-time ${graceTime} --sock-path ${shellEscape(sockFile)}${endpointDirArg} --credential-file ${shellEscape(credentialFile)} --log-file ${shellEscape(logFile)} > ${shellEscape(logFile)} 2>&1 </dev/null &`
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
    `cd ${escapedDir} && ${escapedNode} relay.js --connect --sock-path ${shellEscape(sockFile)} --credential-file ${shellEscape(credentialFile)}`,
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
  const output = await execCommand(conn, resolveShortRelaySocketDirCommand(versionSegment), {
    signal
  }).catch((err: unknown) => {
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
  await writeRelayEndpointCredential(
    conn,
    hostPlatform,
    launchOpts.nodePath,
    launchOpts.credentialFile,
    { signal }
  )
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
      launchOpts.credentialFile
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
    `& ${powerShellLiteral(nodePath)} relay.js --connect --sock-path ${powerShellLiteral(sockPath)} --credential-file ${powerShellLiteral(credentialFile)}`
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
  credentialFile: string
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
    '--credential-file',
    quoted(credentialFile),
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
      `& icacls.exe ${powerShellLiteral(credentialFile)} /inheritance:r /grant:r "$($env:USERNAME):(R,W)" | Out-Null`,
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
