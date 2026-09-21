import type { SshConnection } from './ssh-connection'
import { shellEscape } from './ssh-connection-utils'
import { execCommand } from './ssh-relay-deploy-helpers'
import { relaySocketNameForInstanceId } from './ssh-relay-instance-id'
import { SHORT_RELAY_SOCKET_DIR_PREFIX } from './relay-socket-path-limit'

export async function forceStopRelayForTarget(
  conn: SshConnection,
  relayInstanceId: string
): Promise<void> {
  const sockName = relaySocketNameForInstanceId(relayInstanceId)
  const escapedSockName = shellEscape(sockName)
  const script = [
    `sock_name=${escapedSockName}`,
    'base="${HOME}/.orca-remote"',
    // Why: a long $HOME moves the socket to the sun_path-safe short base (#10726); reset must reach it there too.
    `short_base="${SHORT_RELAY_SOCKET_DIR_PREFIX}$(id -u 2>/dev/null)"`,
    'if [ -d "$base" ] || [ -d "$short_base" ]; then',
    '  for sock in "$base"/relay-*/"$sock_name" "$base"/"$sock_name" "$short_base"/relay-*/"$sock_name"; do',
    '    [ -S "$sock" ] || continue',
    '    pid=""',
    // Why: lsof ORs selectors by default; -a prevents reset from targeting
    // every Unix-socket holder instead of only the per-relay socket (#8762).
    '    if command -v lsof >/dev/null 2>&1; then',
    '      pid=$(lsof -t -a -U "$sock" 2>/dev/null | tr "\\n" " ")',
    '    fi',
    '    if [ -z "$pid" ] && command -v pgrep >/dev/null 2>&1; then',
    '      pid=$(pgrep -f "$sock_name" 2>/dev/null | ' +
      'awk -v self="$$" -v parent="$PPID" \'$1 != self && $1 != parent\' | tr "\\n" " ")',
    '    fi',
    '    if [ -n "$pid" ]; then',
    '      kill -TERM $pid 2>/dev/null || true',
    '      sleep 0.2',
    '      kill -KILL $pid 2>/dev/null || true',
    '    fi',
    '    rm -f "$sock"',
    '  done',
    'fi'
  ].join('\n')

  await execCommand(conn, script)
}
