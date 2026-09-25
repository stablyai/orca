import { execCommand } from './ssh-relay-deploy-helpers'
import { shellEscape } from './ssh-connection-utils'
import type { SshConnection } from './ssh-connection'
import { joinRemotePath, type RemoteHostPlatform } from './ssh-remote-platform'
import { ORCAD_INSTALL_MODEL } from './remote-install-model'
import { acquireInstallLock } from './ssh-relay-install-lock'
import { uploadRelayDirectory, writeRelayFile } from './ssh-relay-install-transfers'
import {
  abandonInstall,
  finalizeInstall,
  isRemoteInstallComplete
} from './ssh-relay-versioned-install'

/** Install the bytes under `orcad-<version>/`, using the relay's install transaction. */
export async function installOrcadBundle(
  options: {
    conn: SshConnection
    host: RemoteHostPlatform
    localOrcadDir: string
    signal?: AbortSignal
  },
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
      return
    }
    await uploadRelayDirectory(options.conn, options.localOrcadDir, remoteDir, options.host, {
      signal: options.signal
    })
    if (options.host.os !== 'win32') {
      const binaryPath = joinRemotePath(
        options.host,
        remoteDir,
        'ripgrep',
        options.host.relayPlatform,
        'rg'
      )
      await execCommand(options.conn, `chmod 755 ${shellEscape(binaryPath)}`, {
        wrapCommand: options.host.commandDialect !== 'powershell',
        signal: options.signal
      })
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
  } finally {
    await abandonInstall(options.conn, remoteDir, options.host)
  }
}
