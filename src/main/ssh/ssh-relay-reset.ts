import type { SshConnection } from './ssh-connection'
import { shellEscape } from './ssh-connection-utils'
import { execCommand } from './ssh-relay-deploy-helpers'
import { relaySocketNameForInstanceId } from './ssh-relay-instance-id'
import { zmxPtyNamespaceForRelaySocketName } from '../../shared/zmx-pty-namespace'
import type { SshTerminalPersistenceBackend } from '../../shared/ssh-terminal-persistence'

const PTY_BACKEND_OUTPUT_PREFIX = '__ORCA_PTY_BACKEND__='

export async function forceStopRelayForTarget(
  conn: SshConnection,
  relayInstanceId: string,
  options: { preserveZmxSessions?: boolean } = {}
): Promise<SshTerminalPersistenceBackend> {
  const sockName = relaySocketNameForInstanceId(relayInstanceId)
  const escapedSockName = shellEscape(sockName)
  const zmxNamespace = zmxPtyNamespaceForRelaySocketName(sockName)
  const script = [
    `sock_name=${escapedSockName}`,
    'base="${HOME}/.orca-remote"',
    'pty_backend=relay',
    'marker_read=',
    // Why: the launcher writes the marker next to the versioned relay socket
    // ($base/relay-<version>/<sock>.pty-backend); prefer the marker whose relay
    // socket is live, falling back to any marker a dead relay left behind.
    'if [ -d "$base" ]; then',
    '  for marker in "$base"/relay-*/"$sock_name".pty-backend "$base"/"$sock_name".pty-backend; do',
    '    [ -f "$marker" ] || continue',
    '    if [ -S "${marker%.pty-backend}" ] || [ -z "$marker_read" ]; then',
    '      IFS= read -r pty_backend < "$marker" || true',
    '      marker_read=1',
    '    fi',
    '    [ -S "${marker%.pty-backend}" ] && break',
    '  done',
    'fi',
    'case "$pty_backend" in zmx) ;; *) pty_backend=relay ;; esac',
    `printf '${PTY_BACKEND_OUTPUT_PREFIX}%s\\n' "$pty_backend"`,
    'if [ -d "$base" ]; then',
    '  for sock in "$base"/relay-*/"$sock_name" "$base"/"$sock_name"; do',
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
    '    rm -f "$sock" "$sock.pty-backend"',
    '  done',
    'fi',
    ...(options.preserveZmxSessions
      ? []
      : [
          `zmx_dir="\${HOME}/.orca-remote/zmx-pty/${zmxNamespace}/runtime"`,
          `zmx_metadata_dir="\${HOME}/.orca-remote/zmx-pty/${zmxNamespace}/metadata"`,
          'if [ -d "$zmx_dir" ]; then',
          '  zmx_bin=$(command -v zmx 2>/dev/null || true)',
          '  if [ -z "$zmx_bin" ]; then',
          '    for candidate in /opt/homebrew/bin/zmx /usr/local/bin/zmx "$HOME/.local/bin/zmx" "$HOME/bin/zmx"; do',
          '      [ -x "$candidate" ] && zmx_bin="$candidate" && break',
          '    done',
          '  fi',
          '  if [ -z "$zmx_bin" ]; then',
          '    shell_bin="${SHELL:-/bin/sh}"',
          '    if [ -x "$shell_bin" ]; then',
          '      zmx_bin=$("$shell_bin" -lc \'command -v zmx\' 2>/dev/null | tail -n 1)',
          '      [ -x "$zmx_bin" ] || zmx_bin=',
          '    fi',
          '  fi',
          '  if [ -z "$zmx_bin" ]; then',
          '    for zmx_sock in "$zmx_dir"/pty-*; do',
          '      [ -S "$zmx_sock" ] || continue',
          // Why: a socket inode can outlive its session (host reboot); only a
          // live holder proves a session zmx must end. Stale sockets are swept
          // so retries do not fail forever after the relay is already gone.
          '      holder=""',
          '      if command -v lsof >/dev/null 2>&1; then',
          '        holder=$(lsof -t -a -U "$zmx_sock" 2>/dev/null | tr "\\n" " ")',
          '      fi',
          '      if [ -n "$holder" ]; then',
          '        echo "zmx is required to end persistent Orca terminals" >&2',
          '        exit 1',
          '      fi',
          '      rm -f "$zmx_sock"',
          '    done',
          '  fi',
          '  if [ -n "$zmx_bin" ]; then',
          '    sessions=$(ZMX_DIR="$zmx_dir" "$zmx_bin" list --short) || exit 1',
          '    for session in $sessions; do',
          '      case "$session" in pty-[0-9]*) ZMX_DIR="$zmx_dir" "$zmx_bin" kill "$session" || exit 1 ;; esac',
          '    done',
          '  fi',
          'fi',
          'rm -f "$zmx_metadata_dir"/pty-*.json'
        ]),
    // Why: marker cleanup runs LAST — if the zmx-kill branch exits 1 above, the
    // surviving zmx marker keeps fencing relay-backed connects so the sessions
    // it describes stay reachable instead of being silently orphaned.
    'if [ -d "$base" ]; then',
    '  rm -f "$base"/relay-*/"$sock_name".pty-backend "$base"/"$sock_name".pty-backend',
    'fi'
  ].join('\n')

  const output = await execCommand(conn, script)
  return output.split(/\r?\n/).some((line) => line.trim() === `${PTY_BACKEND_OUTPUT_PREFIX}zmx`)
    ? 'zmx'
    : 'relay'
}
