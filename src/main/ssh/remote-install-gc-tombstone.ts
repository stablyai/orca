import type { SshConnection } from './ssh-connection'
import { execCommand } from './ssh-relay-deploy-helpers'
import { removeRemoteTreeCommand } from './ssh-remote-commands'
import { remoteInstallGcTombstoneRegex, type RemoteInstallModel } from './remote-install-model'
import {
  getRemoteHostPlatform,
  isWindowsRemoteHost,
  joinRemotePath,
  type RemoteHostPlatform
} from './ssh-remote-platform'

const DEFAULT_REMOTE_HOST = getRemoteHostPlatform('linux-x64')

export async function cleanupRemoteInstallGcTombstones(
  conn: SshConnection,
  model: RemoteInstallModel,
  baseDir: string,
  entries: string[],
  host: RemoteHostPlatform = DEFAULT_REMOTE_HOST
): Promise<void> {
  const tombstoneRegex = remoteInstallGcTombstoneRegex(model)
  // A confirmed rename isolates these paths from any recreated install.
  for (const name of entries.filter((entry) => tombstoneRegex.test(entry))) {
    const tombstone = joinRemotePath(host, baseDir, name)
    await execCommand(conn, removeRemoteTreeCommand(host, tombstone), {
      wrapCommand: !isWindowsRemoteHost(host)
    }).catch((error) => {
      console.warn(
        `[${model.id}] GC failed to remove tombstone ${tombstone}: ${error instanceof Error ? error.message : String(error)}`
      )
    })
  }
}
