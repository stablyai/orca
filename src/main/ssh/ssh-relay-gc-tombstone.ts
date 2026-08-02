import type { SshConnection } from './ssh-connection'
import { execCommand } from './ssh-relay-deploy-helpers'
import { removeRemoteTreeCommand } from './ssh-remote-commands'
import {
  getRemoteHostPlatform,
  isWindowsRemoteHost,
  joinRemotePath,
  type RemoteHostPlatform
} from './ssh-remote-platform'

const DEFAULT_REMOTE_HOST = getRemoteHostPlatform('linux-x64')
const RELAY_GC_TOMBSTONE_REGEX =
  /^relay-(?:v?\d+\.\d+\.\d+(?:\+[0-9a-f]+)?)\.gc-tombstone\.\d+\.\d+$/

export async function cleanupRelayGcTombstones(
  conn: SshConnection,
  baseDir: string,
  entries: string[],
  host: RemoteHostPlatform = DEFAULT_REMOTE_HOST
): Promise<void> {
  // Why: a confirmed rename isolates these paths from any recreated install.
  // Strictly named leftovers are safe to retry after an interrupted GC pass.
  for (const name of entries.filter((entry) => RELAY_GC_TOMBSTONE_REGEX.test(entry))) {
    const tombstone = joinRemotePath(host, baseDir, name)
    await execCommand(conn, removeRemoteTreeCommand(host, tombstone), {
      wrapCommand: !isWindowsRemoteHost(host)
    }).catch((err) => {
      console.warn(
        `[ssh-relay] GC failed to remove tombstone ${tombstone}: ${err instanceof Error ? err.message : String(err)}`
      )
    })
  }
}
