import type { SshConnection } from './ssh-connection'
import { shellEscape } from './ssh-connection-utils'
import { execCommand } from './ssh-relay-deploy-helpers'
import { relaySocketNameForInstanceId } from './ssh-relay-instance-id'

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
    '  for sock in "$base"/relay-*/"$sock_name" "$base"/"$sock_name"; do',
    '    [ -S "$sock" ] || continue',
    '    pid=""',
    // Why: lsof ORs its selectors by default, so `-U "$sock"` means "any
    // unix-socket holder OR $sock opener" — on hosts where lsof cannot match
    // AF_UNIX sockets by path that degrades to every unix-socket holder,
    // including systemd --user, and the sweep kills the whole session
    // (#8762). `-a` ANDs the selectors; where path matching is unsupported
    // it yields nothing and the cmdline-scoped pgrep fallback takes over.
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
