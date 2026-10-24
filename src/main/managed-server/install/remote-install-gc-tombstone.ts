import type { RemoteInstallTransport } from './remote-install-transport'
import {
  execCommand,
  isUnconfirmedSshCommandTermination
} from '../../ssh/remote-exec/remote-exec-command'
import { remoteInstallGcTombstoneRegex, type RemoteInstallModel } from './remote-install-model'
import { removeRemoteTreeCommand } from '../../ssh/ssh-remote-commands'
import {
  getRemoteHostPlatform,
  isWindowsRemoteHost,
  joinRemotePath,
  type RemoteHostPlatform
} from '../../ssh/ssh-remote-platform'

const DEFAULT_REMOTE_HOST = getRemoteHostPlatform('linux-x64')

export async function cleanupRemoteInstallGcTombstones(
  conn: RemoteInstallTransport,
  model: RemoteInstallModel,
  baseDir: string,
  entries: string[],
  host: RemoteHostPlatform = DEFAULT_REMOTE_HOST
): Promise<void> {
  // Confirmed rename isolates tombstones from recreated installs, so interrupted deletion is retryable.
  const tombstoneRegex = remoteInstallGcTombstoneRegex(model)
  for (const name of entries.filter((entry) => tombstoneRegex.test(entry))) {
    const tombstone = joinRemotePath(host, baseDir, name)
    await execCommand(conn, removeRemoteTreeCommand(host, tombstone), {
      wrapCommand: !isWindowsRemoteHost(host)
    }).catch((err) => {
      if (isUnconfirmedSshCommandTermination(err)) {
        throw err
      }
      console.warn(
        `[${model.id}] GC failed to remove tombstone ${tombstone}: ${err instanceof Error ? err.message : String(err)}`
      )
    })
  }
}
