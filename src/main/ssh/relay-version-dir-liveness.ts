/**
 * Whether a relay version directory is still in use, answered with the execution-boundary
 * vocabulary (docs/reference/ssh-execution-boundary.md): `live` / `unverifiable` / `exited`.
 *
 * Design D5: a directory is `exited` only when its recorded `.relay-pid` is provably dead AND
 * every `relay-*.sock` in it refuses a connection. The PID is checked first so a live daemon
 * about to idle is never connected to (a connection would cancel its grace timer). A directory
 * with no PID file was last used by a relay that predates it and keeps the `test -S` rule.
 */
import { RELAY_PID_FILENAME } from '../../shared/relay-artifacts'
import { shellEscape } from './ssh-connection-utils'
import { posixProcessAliveShellFunction } from './orcad-remote-host-support'
import { RELAY_CONNECT_PROBE_JS, type RelayEndpointVerdict } from './ssh-relay-endpoint-incumbent'
import { relayLivenessProbeCommand, type WindowsRelayLivenessOptions } from './ssh-remote-commands'
import { isWindowsRemoteHost, type RemoteHostPlatform } from './ssh-remote-platform'

export function relayVersionDirLivenessCommand(
  host: RemoteHostPlatform,
  dir: string,
  options: { nodePath?: string; windows?: WindowsRelayLivenessOptions } = {}
): string {
  if (isWindowsRemoteHost(host)) {
    return relayLivenessProbeCommand(host, dir, options.windows)
  }
  return [
    `dir=${shellEscape(dir)}`,
    `node=${shellEscape(options.nodePath ?? '')}`,
    `pid_file="$dir"/${RELAY_PID_FILENAME}`,
    'socks=',
    'for f in "$dir"/relay-*.sock "$dir"/relay.sock; do [ -S "$f" ] && socks=yes; done',
    'if [ ! -e "$pid_file" ]; then',
    '  if [ -n "$socks" ]; then echo LIVE; else echo EXITED; fi',
    '  exit 0',
    'fi',
    // Prints UNKNOWN and exits when kill -0 fails for any reason but "No such process".
    posixProcessAliveShellFunction({ refuseUnverifiable: true }),
    'pid=$(cat "$pid_file" 2>/dev/null) || { echo UNVERIFIABLE; exit 0; }',
    'case "$pid" in "" | *[!0-9]*) echo UNVERIFIABLE; exit 0;; esac',
    'if orcad_alive "$pid"; then echo LIVE; exit 0; fi',
    'for f in "$dir"/relay-*.sock "$dir"/relay.sock; do',
    '  [ -S "$f" ] || continue',
    '  [ -n "$node" ] || { echo UNVERIFIABLE; exit 0; }',
    // Another relay of this build may share the dir under its own socket; only a refusal clears it.
    `  r=$("$node" -e ${shellEscape(RELAY_CONNECT_PROBE_JS)} "$f" 2>/dev/null) || r=unknown`,
    '  case "$r" in',
    '    refused | absent) ;;',
    '    accepted) echo LIVE; exit 0;;',
    '    *) echo UNVERIFIABLE; exit 0;;',
    '  esac',
    'done',
    'echo EXITED'
  ].join('\n')
}

export function parseRelayVersionDirLiveness(output: string): RelayEndpointVerdict {
  const token = output.trim().split('\n').pop()?.trim() ?? ''
  // ALIVE / DEAD / WAITING are the Windows pipe probe's vocabulary.
  if (token === 'LIVE' || token === 'ALIVE') {
    return 'live'
  }
  if (token === 'EXITED' || token === 'DEAD' || token === 'WAITING') {
    return 'exited'
  }
  return 'unverifiable'
}
