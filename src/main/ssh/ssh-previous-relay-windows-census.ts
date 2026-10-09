/**
 * The previous-relay census for Windows hosts, where relay endpoints are named pipes with no inode to
 * list. Each older version directory's pipe name is derived from that directory and this target's
 * socket name, so probing those pipes answers the same question the POSIX socket listing does.
 */
import type { SshConnection } from './ssh-connection'
import { RELAY_REMOTE_DIR } from './relay-protocol'
import { probeRelayVersionDirLiveness } from './remote-install-gc'
import { RELAY_INSTALL_MODEL, remoteInstallVersionDirRegex } from './remote-install-model'
import { execCommand } from './ssh-relay-deploy-helpers'
import { relaySocketNameForInstanceId } from './ssh-relay-instance-id'
import { listRemoteInstallBaseDirsCommand } from './ssh-remote-commands'
import { joinRemotePath, remoteBasename, type RemoteHostPlatform } from './ssh-remote-platform'

/** Older version directories whose pipe for this target is live or unverifiable. */
export async function censusWindowsPreviousRelays(
  conn: SshConnection,
  targetId: string,
  input: { host: RemoteHostPlatform; remoteHome: string; remoteRelayDir: string; nodePath: string },
  maxEndpoints: number
): Promise<{ endpoints: string[]; truncated: boolean }> {
  const { host, remoteHome, remoteRelayDir, nodePath } = input
  const baseDir = joinRemotePath(host, remoteHome, RELAY_REMOTE_DIR)
  const current = remoteBasename(remoteRelayDir, host)
  const versionDir = remoteInstallVersionDirRegex(RELAY_INSTALL_MODEL)
  const listing = await execCommand(
    conn,
    listRemoteInstallBaseDirsCommand(host, baseDir, RELAY_INSTALL_MODEL),
    { wrapCommand: false }
  )
  const older = listing
    .split('\n')
    .map((line) => line.trim())
    .filter((name) => versionDir.test(name) && name !== current)
  const endpoints: string[] = []
  for (const name of older.slice(0, maxEndpoints)) {
    const dir = joinRemotePath(host, baseDir, name)
    const verdict = await probeRelayVersionDirLiveness(conn, dir, host, {
      windowsNodePath: nodePath,
      windowsSockNames: [relaySocketNameForInstanceId(targetId)]
    })
    if (verdict !== 'exited') {
      endpoints.push(dir)
    }
  }
  return { endpoints, truncated: older.length > maxEndpoints }
}
