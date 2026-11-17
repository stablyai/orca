import { randomUUID } from 'node:crypto'
import {
  isOrcadExecutableArtifact,
  orcadArtifactFilenames
} from '../../../shared/remote-runtime/orcad-distribution/orcad-artifacts'
import { orcadAgentBrowserNativeName } from '../../../shared/remote-runtime/orcad-distribution/orcad-agent-browser-name'
import type { NodeRuntimeTarget } from '../../../shared/node-runtime/node-runtime-pin'
import { ensureRemoteOrcadNodeRuntime } from './orcad-remote-node-runtime'
import { recordedRemoteNodeRuntimeProbeCommand } from './orcad-remote-node-runtime-recorded-probe'
import { cachedOrcadSlotInstalled } from './orcad-remote-install-cached-probe'
import {
  execCommand,
  isUnconfirmedSshCommandTermination
} from '../../ssh/remote-exec/remote-exec-command'
import { quotePosixShell } from '../../../shared/shell/launch/shell-argument-quoting'
import type { OrcadHostTransport } from './orcad-host-transport'
import { joinRemotePath, type RemoteHostPlatform } from '../../ssh/remote-host/ssh-remote-platform'
import { ORCAD_INSTALL_MODEL } from './remote-install-model'
import { acquireInstallLock, type InstallLockWait } from './remote-install-lock'
import { installLockFenceStatement } from './remote-install-lock-holder-commands'
import { startInstallLockHolder, type InstallLockHolder } from './remote-install-lock-holder'
import { RELAY_INSTALL_LOCK_NAME } from '../../../shared/remote-runtime/relay/relay-install-lock-name'
import { ORCAD_FENCE_OWNER_FILENAME } from '../activation/orcad-activation-fence-scope'
import { forgetHeldOrcadFence, rememberHeldOrcadFence } from '../activation/orcad-held-fence-tokens'
import { exitedOwnLockProof } from '../activation/orcad-exited-own-lock'
import { orcadWindowsBaseDir } from './orcad-remote-windows-node'
import { uploadRemoteInstallDirectory, writeRemoteInstallFile } from './remote-install-transfers'
import {
  abandonInstall,
  finalizeInstall,
  isRemoteInstallComplete
} from './remote-versioned-install'

export async function installOrcadBundle(
  options: {
    conn: OrcadHostTransport
    host: RemoteHostPlatform
    localOrcadDir: string
    target: NodeRuntimeTarget
    /** Lazily acquire verified runtime bytes only if the host needs them. */
    nodeRuntimeArchive: () => Promise<string>
    /** Offline archive location named when downloads fail. */
    nodeRuntimeOfflineArchivePath?: string
    /** Per-source connect budget for the host's own download fallback. */
    nodeRuntimeHostConnectTimeoutSeconds?: number
    /** WSL opt-in: reuse a matching stat signature previously hashed to this pin. */
    recordedNodeRuntimeProbe?: boolean
    /** WSL opt-in: wait through to stale takeover instead of giving up at the step timeout. */
    localWslHost?: boolean
    /** Another holder keeps the install lock: called at each recheck, then with null once taken. */
    onInstallLockWait?: (wait: InstallLockWait | null) => void
    signal?: AbortSignal
  },
  fullVersion: string,
  remoteDir: string
): Promise<'uploaded' | 'reused'> {
  if (options.recordedNodeRuntimeProbe && (await cachedOrcadSlotInstalled(options, remoteDir))) {
    return 'reused'
  }
  // Existing slot bytes are unusable without their referenced runtime.
  await ensureRemoteOrcadNodeRuntime({
    conn: options.conn,
    host: options.host,
    slotDir: remoteDir,
    target: options.target,
    archivePath: options.nodeRuntimeArchive,
    offlineArchivePath: options.nodeRuntimeOfflineArchivePath,
    hostConnectTimeoutSeconds: options.nodeRuntimeHostConnectTimeoutSeconds,
    signal: options.signal,
    ...(options.recordedNodeRuntimeProbe
      ? { posixProbeCommand: recordedRemoteNodeRuntimeProbeCommand }
      : {})
  })
  if (
    await isRemoteInstallComplete(options.conn, ORCAD_INSTALL_MODEL, remoteDir, options.host, {
      signal: options.signal
    })
  ) {
    return 'reused'
  }
  // Persist the token so a relaunch can prove ownership of an interrupted upload lock.
  const token = randomUUID()
  const owner = { fileName: ORCAD_FENCE_OWNER_FILENAME, token }
  rememberHeldOrcadFence(token)
  let waited = false
  // No forget on failure: a lost reply may follow a committed create or steal, and the token is
  // the only proof a relaunch has. Unused entries age out of the store in 24h.
  await acquireInstallLock(options.conn, remoteDir, options.host, {
    signal: options.signal,
    owner,
    // SFTP uploads and chmod leave no host workload after this client exits.
    exitedOwner: exitedOwnLockProof(options, {
      baseDir: orcadWindowsBaseDir(options.host, remoteDir),
      guardsStateMutation: false
    }),
    // SSH keeps its bounded wait: a slow live upload elsewhere never refreshes the lock's age.
    ...(options.localWslHost
      ? {
          probeExitedHolder: true,
          waitThroughStaleTakeover: true,
          onWait: (wait: InstallLockWait) => {
            waited = true
            options.onInstallLockWait?.(wait)
          }
        }
      : {})
  })
  if (waited) {
    options.onInstallLockWait?.(null)
  }

  let preserveInstallLock = false
  let holder: InstallLockHolder | null = null
  let conn: OrcadHostTransport = options.conn
  let signal = options.signal
  try {
    const held = await holdInstallLock(options, remoteDir, owner)
    if (held) {
      ;({ holder, conn, signal } = held)
    }
    // A sibling may have completed deployment while this client waited for the lock.
    if (
      await isRemoteInstallComplete(conn, ORCAD_INSTALL_MODEL, remoteDir, options.host, {
        signal
      })
    ) {
      return 'reused'
    }
    await uploadRemoteInstallDirectory(conn, options.localOrcadDir, remoteDir, options.host, {
      signal
    })
    if (options.host.os !== 'win32') {
      await execCommand(
        conn,
        executablePermissionsCommand(options.host, remoteDir, options.target),
        {
          wrapCommand: options.host.commandDialect !== 'powershell',
          signal
        }
      )
    }
    await writeRemoteInstallFile(
      conn,
      options.host,
      joinRemotePath(options.host, remoteDir, ORCAD_INSTALL_MODEL.versionFilename),
      fullVersion,
      { signal }
    )
    await finalizeInstall(conn, remoteDir, options.host, { signal, releaseLock: false })
    return 'uploaded'
  } catch (error) {
    preserveInstallLock = isUnconfirmedSshCommandTermination(error)
    throw error
  } finally {
    try {
      if (!preserveInstallLock) {
        // Retain ownership proof if interrupted cleanup cannot confirm lock removal.
        // Token-checked: a cleanup that runs after a takeover leaves the successor's lock alone.
        if (await abandonInstall(conn, remoteDir, options.host, owner)) {
          forgetHeldOrcadFence(token)
        }
      }
    } finally {
      // After cleanup: a lock left behind is then reclaimable once its last fenced command ends.
      holder?.release()
    }
  }
}

/** WSL: back the lock with a guest kernel lock so a contender can prove this install gone, and
 * fence every install command on it. Null keeps today's unbacked lock. */
async function holdInstallLock(
  options: {
    conn: OrcadHostTransport
    host: RemoteHostPlatform
    localWslHost?: boolean
    signal?: AbortSignal
  },
  remoteDir: string,
  owner: { fileName: string; token: string }
): Promise<{ holder: InstallLockHolder; conn: OrcadHostTransport; signal: AbortSignal } | null> {
  const withFence = options.conn.withCommandFence
  if (!options.localWslHost || !withFence || options.host.os === 'win32') {
    return null
  }
  const lockDir = joinRemotePath(options.host, remoteDir, RELAY_INSTALL_LOCK_NAME)
  const holder = await startInstallLockHolder(options.conn, lockDir, owner, options.signal)
  if (!holder) {
    return null
  }
  // A holder lost mid-install ends this install: its lock is now reclaimable.
  const lost = new AbortController()
  void holder.lost.then(() => lost.abort(new Error('The install lock holder exited.')))
  return {
    holder,
    conn: withFence.call(options.conn, installLockFenceStatement(lockDir, owner)),
    signal: options.signal ? AbortSignal.any([options.signal, lost.signal]) : lost.signal
  }
}

export function executablePermissionsCommand(
  host: RemoteHostPlatform,
  directory: string,
  target: NodeRuntimeTarget
): string {
  const required = orcadArtifactFilenames(target, [])
    .filter(isOrcadExecutableArtifact)
    .map((artifact) => joinRemotePath(host, directory, ...artifact.split('/')))
  const browsers = new Set(
    (['glibc', 'musl'] as const).map((libc) =>
      quotePosixShell(
        joinRemotePath(host, directory, orcadAgentBrowserNativeName(host.os, host.arch, libc))
      )
    )
  )
  // Restore executable modes lost by SFTP; absent optional browser binaries remain supported.
  return (
    `chmod 755 ${required.map(quotePosixShell).join(' ')} && ` +
    `for executable in ${[...browsers].join(' ')}; do ` +
    'if [ -f "$executable" ]; then chmod 755 "$executable" || exit $?; fi; done'
  )
}
