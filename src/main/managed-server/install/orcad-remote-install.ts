import { randomUUID } from 'node:crypto'
import { orcadNodePtyNativeArtifacts, orcadRipgrepArtifact } from '../../../shared/orcad-artifacts'
import { orcadAgentBrowserNativeName } from '../../../shared/orcad-agent-browser-name'
import type { NodeRuntimeTarget } from '../../../shared/node-runtime-pin'
import { ensureRemoteOrcadNodeRuntime } from './orcad-remote-node-runtime'
import { recordedRemoteNodeRuntimeProbeCommand } from './orcad-remote-node-runtime-recorded-probe'
import {
  execCommand,
  isUnconfirmedSshCommandTermination
} from '../../ssh/remote-exec/remote-exec-command'
import { quotePosixShell } from '../../../shared/shell-argument-quoting'
import type { OrcadHostTransport } from '../../ssh/orcad-host-transport'
import { joinRemotePath, type RemoteHostPlatform } from '../../ssh/ssh-remote-platform'
import { ORCAD_INSTALL_MODEL } from './remote-install-model'
import { acquireInstallLock } from './remote-install-lock'
import { ORCAD_FENCE_OWNER_FILENAME } from '../activation/orcad-activation-fence-scope'
import { forgetHeldOrcadFence, rememberHeldOrcadFence } from '../../ssh/orcad-held-fence-tokens'
import { exitedOwnLockProof } from '../../ssh/orcad-exited-own-lock'
import { orcadWindowsBaseDir } from './orcad-remote-windows-node'
import { uploadRelayDirectory, writeRelayFile } from './remote-install-transfers'
import {
  abandonInstall,
  finalizeInstall,
  isRemoteInstallComplete
} from './remote-versioned-install'

/** Install the bytes under `orcad-<version>/`, using the relay's install transaction. */
export async function installOrcadBundle(
  options: {
    conn: OrcadHostTransport
    host: RemoteHostPlatform
    localOrcadDir: string
    target: NodeRuntimeTarget
    /** The locally verified pinned Node archive, fetched only when the host lacks the runtime. */
    nodeRuntimeArchive: () => Promise<string>
    /** WSL only: skip re-hashing a runtime whose stat signature is unchanged since it hashed to the pin. */
    recordedNodeRuntimeProbe?: boolean
    signal?: AbortSignal
  },
  fullVersion: string,
  remoteDir: string
): Promise<void> {
  // Why before the slot probe: an installed slot is unlaunchable without the runtime it names.
  await ensureRemoteOrcadNodeRuntime({
    conn: options.conn,
    host: options.host,
    slotDir: remoteDir,
    target: options.target,
    archivePath: options.nodeRuntimeArchive,
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
    return
  }
  // Its token lets a relaunch prove a lock its own quit left mid-upload (BUG-23).
  const token = randomUUID()
  rememberHeldOrcadFence(token)
  try {
    await acquireInstallLock(options.conn, remoteDir, options.host, {
      signal: options.signal,
      owner: { fileName: ORCAD_FENCE_OWNER_FILENAME, token },
      // Nothing keeps writing once its client exited: uploads are SFTP and chmod is immediate.
      exitedOwner: exitedOwnLockProof(options, {
        baseDir: orcadWindowsBaseDir(options.host, remoteDir),
        guardsStateMutation: false
      })
    })
  } catch (error) {
    if (!isUnconfirmedSshCommandTermination(error)) {
      forgetHeldOrcadFence(token)
    }
    throw error
  }
  let preserveInstallLock = false
  try {
    // Re-probe under the lock: a sibling deploy may have finished while we waited.
    if (
      await isRemoteInstallComplete(options.conn, ORCAD_INSTALL_MODEL, remoteDir, options.host, {
        signal: options.signal
      })
    ) {
      return
    }
    await uploadRelayDirectory(options.conn, options.localOrcadDir, remoteDir, options.host, {
      signal: options.signal
    })
    if (options.host.os !== 'win32') {
      await execCommand(
        options.conn,
        executablePermissionsCommand(options.host, remoteDir, options.target),
        {
          wrapCommand: options.host.commandDialect !== 'powershell',
          signal: options.signal
        }
      )
    }
    await writeRelayFile(
      options.conn,
      options.host,
      joinRemotePath(options.host, remoteDir, ORCAD_INSTALL_MODEL.versionFilename),
      fullVersion,
      { signal: options.signal }
    )
    await finalizeInstall(options.conn, remoteDir, options.host, {
      signal: options.signal,
      releaseLock: false
    })
  } catch (error) {
    preserveInstallLock = isUnconfirmedSshCommandTermination(error)
    throw error
  } finally {
    if (!preserveInstallLock) {
      // A removal a quit cut short keeps the token, so the relaunch can prove the lock its own.
      if (await abandonInstall(options.conn, remoteDir, options.host)) {
        forgetHeldOrcadFence(token)
      }
    }
  }
}

export function executablePermissionsCommand(
  host: RemoteHostPlatform,
  directory: string,
  target: NodeRuntimeTarget
): string {
  const required = [orcadRipgrepArtifact(target), ...orcadNodePtyNativeArtifacts(target)]
    .filter((artifact) => /\/(?:rg|spawn-helper)$/.test(artifact))
    .map((artifact) => joinRemotePath(host, directory, ...artifact.split('/')))
  const browsers = new Set(
    (['glibc', 'musl'] as const).map((libc) =>
      quotePosixShell(
        joinRemotePath(host, directory, orcadAgentBrowserNativeName(host.os, host.arch, libc))
      )
    )
  )
  // SFTP drops executable modes; missing optional browser binaries remain a supported install.
  return (
    `chmod 755 ${required.map(quotePosixShell).join(' ')} && ` +
    `for executable in ${[...browsers].join(' ')}; do ` +
    'if [ -f "$executable" ]; then chmod 755 "$executable" || exit $?; fi; done'
  )
}
