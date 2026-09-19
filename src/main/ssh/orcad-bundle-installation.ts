import type { OrcadDeployOptions } from './orcad-remote-deploy'
import { isUnconfirmedSshCommandTermination } from './ssh-relay-deploy-helpers'
import { exec } from './orcad-remote-runtime-control'
import { ORCAD_INSTALL_MODEL } from './remote-install-model'
import { acquireInstallLock } from './ssh-relay-install-lock'
import { uploadRelayDirectory, writeRelayFile } from './ssh-relay-install-transfers'
import {
  abandonInstall,
  finalizeInstall,
  isRemoteInstallComplete
} from './ssh-relay-versioned-install'
import { isWindowsRemoteHost, joinRemotePath } from './ssh-remote-platform'
import { ORCAD_BUN_RUNTIME_FILENAME } from '../../shared/orcad-artifacts'
import { shellEscape } from './ssh-connection-utils'
import {
  createRelayInstallMarkerCommand,
  createRelayInstallNamespace,
  relaySftpNamespaceMapping,
  remoteInstallHomeRelativeDir,
  type RelayInstallNamespace
} from './ssh-relay-install-namespace'

/** Install versioned bytes using the relay's existing upload and install-lock transaction. */
export async function installOrcadBundle(
  options: OrcadDeployOptions,
  fullVersion: string,
  remoteDir: string
): Promise<void> {
  if (
    await isRemoteInstallComplete(options.conn, ORCAD_INSTALL_MODEL, remoteDir, options.host, {
      signal: options.signal
    })
  ) {
    return
  }
  await acquireInstallLock(options.conn, remoteDir, options.host, { signal: options.signal })
  try {
    // Re-probe under the lock: a sibling deploy may have finished while we waited.
    if (
      await isRemoteInstallComplete(options.conn, ORCAD_INSTALL_MODEL, remoteDir, options.host, {
        signal: options.signal
      })
    ) {
      await abandonInstall(options.conn, remoteDir, options.host)
      return
    }
    let namespace: RelayInstallNamespace | undefined
    const usesSystemSsh = options.conn.usesSystemSshTransport?.() === true
    if (!isWindowsRemoteHost(options.host) && !usesSystemSsh) {
      namespace = createRelayInstallNamespace(
        remoteInstallHomeRelativeDir(ORCAD_INSTALL_MODEL, fullVersion)
      )
      try {
        await exec(options, createRelayInstallMarkerCommand(namespace, options.host, remoteDir))
      } catch (error) {
        if (isUnconfirmedSshCommandTermination(error)) {
          throw error
        }
        options.signal?.throwIfAborted()
        console.warn(`[orcad] SFTP namespace marker unavailable at ${remoteDir}`)
        namespace = undefined
      }
    }
    await uploadRelayDirectory(options.conn, options.localOrcadDir, remoteDir, options.host, {
      signal: options.signal,
      sftpNamespace: namespace
        ? relaySftpNamespaceMapping(namespace, options.host, remoteDir)
        : undefined
    })
    if (options.host.commandDialect !== 'powershell') {
      const runtimePath = joinRemotePath(options.host, remoteDir, ORCAD_BUN_RUNTIME_FILENAME)
      const browserPattern = `${shellEscape(remoteDir)}/agent-browser-*`
      await exec(
        options,
        `for executable in ${shellEscape(runtimePath)} ${browserPattern}; do ` +
          'if [ -f "$executable" ]; then chmod 755 "$executable"; fi; done'
      )
    }
    await writeRelayFile(
      options.conn,
      options.host,
      joinRemotePath(options.host, remoteDir, ORCAD_INSTALL_MODEL.versionFilename),
      fullVersion,
      {
        signal: options.signal,
        sftpNamespace: namespace
          ? relaySftpNamespaceMapping(
              namespace,
              options.host,
              remoteDir,
              ORCAD_INSTALL_MODEL.versionFilename
            )
          : undefined
      }
    )
    await finalizeInstall(options.conn, remoteDir, options.host, { signal: options.signal })
  } catch (error) {
    if (isUnconfirmedSshCommandTermination(error)) {
      throw error
    }
    // Leave a recoverable partial rather than a dir that probes complete.
    await abandonInstall(options.conn, remoteDir, options.host)
    throw error
  }
}
