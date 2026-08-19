import type { SshConnection } from './ssh-connection'
import { shellEscape } from './ssh-connection-utils'
import { execCommand } from './ssh-relay-deploy-helpers'
import { relaySocketNameForInstanceId } from './ssh-relay-instance-id'
import { terminateRelaySocketHolderScript } from './ssh-relay-socket-termination'

export async function forceStopRelayForTarget(
  conn: SshConnection,
  relayInstanceId: string
): Promise<void> {
  const sockName = relaySocketNameForInstanceId(relayInstanceId)
  const escapedSockName = shellEscape(sockName)
  const script = [
    `sock_name=${escapedSockName}`,
    'base="${HOME}/.orca-remote"',
    'if [ -d "$base" ]; then',
    // Why: glob every version dir — an older generation's daemon keeps running
    // under its own install dir and only its socket name identifies it.
    '  for sock in "$base"/relay-*/"$sock_name" "$base"/"$sock_name"; do',
    ...terminateRelaySocketHolderScript('"$sock"', '"$sock_name"').map((line) => `    ${line}`),
    '  done',
    'fi'
  ].join('\n')

  await execCommand(conn, script)
}
