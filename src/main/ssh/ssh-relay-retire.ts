import type { SshConnection } from './ssh-connection'
import { shellEscape } from './ssh-connection-utils'
import { execCommand } from './ssh-relay-deploy-helpers'
import { isWindowsRemoteHost, type RemoteHostPlatform } from './ssh-remote-platform'

/**
 * Retire a relay daemon left behind in a superseded version directory (#13614).
 *
 * The GC in ssh-relay-versioned-install.ts keeps any directory whose socket is
 * still alive, so an orphaned daemon blocks its own reclamation forever. This
 * helper distinguishes a true orphan (a listening daemon with zero connected
 * clients) from one still serving a client of an older app build, sends the
 * orphan a graceful SIGTERM, and waits for it to unlink its socket.
 *
 * Best-effort by design: any inconclusive answer returns false so the caller
 * keeps the directory and the next GC pass can try again.
 */
export async function tryRetireOrphanedRelay(
  conn: SshConnection,
  dir: string,
  host: RemoteHostPlatform
): Promise<boolean> {
  if (isWindowsRemoteHost(host)) {
    return false
  }
  try {
    const out = await execCommand(conn, retireOrphanedRelayCommand(dir))
    return out.trim() === 'RETIRED'
  } catch {
    return false
  }
}

export function retireOrphanedRelayCommand(dir: string): string {
  const escapedDir = shellEscape(dir)
  return [
    `dir=${escapedDir}`,
    '[ -d "$dir" ] || { echo RETIRED; exit 0; }',
    'found=0',
    `for sock in "$dir"/relay-*.sock "$dir"/relay.sock; do`,
    '  [ -S "$sock" ] || continue',
    '  found=1',
    '  command -v lsof >/dev/null 2>&1 || { echo KEEP; exit 0; }',
    // Why -a: lsof ORs selectors by default and would list every Unix-socket
    // holder on the host instead of only this socket's users (#8762).
    '  pids=$(lsof -t -a -U "$sock" 2>/dev/null | sort -u)',
    '  count=0',
    '  for p in $pids; do count=$((count+1)); done',
    '  if [ "$count" -gt 1 ]; then echo KEEP; exit 0; fi',
    // Why SIGTERM only: the daemon\'s shutdown handler disposes PTYs gracefully
    // and unlinks its own socket; a KILL here would strand remote shells.
    '  if [ "$count" -eq 1 ]; then kill -TERM $pids 2>/dev/null || true; fi',
    // count=0: stale socket with no holder; leave it for the existing stale
    // socket unlink path so ownership rules stay in one place.
    'done',
    '[ "$found" -eq 0 ] && { echo RETIRED; exit 0; }',
    'i=0',
    'while [ $i -lt 10 ]; do',
    '  alive=0',
    '  for sock in "$dir"/relay-*.sock "$dir"/relay.sock; do',
    '    [ -S "$sock" ] && alive=1 && break',
    '  done',
    '  [ "$alive" -eq 0 ] && { echo RETIRED; exit 0; }',
    '  sleep 0.3',
    '  i=$((i+1))',
    'done',
    'echo KEEP'
  ].join('\n')
}
