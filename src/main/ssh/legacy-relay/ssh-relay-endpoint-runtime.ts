/** Read runtimes from daemon argv so pinned-runtime hosts without Node on PATH can still answer relay probes. */
import type { SshConnection } from '../connection/ssh-connection'
import { execCommand } from '../remote-exec/remote-exec-command'

const RELAY_DAEMON_MARKER = ' relay.js --detached '

/** Use -ww to avoid truncation on procps/BSD; BusyBox rejects it but plain -o args lists every process. */
export const RELAY_DAEMON_ARGV_COMMAND =
  `{ ps -eww -o args= 2>/dev/null || ps -o args= 2>/dev/null; } | ` +
  `grep -F -- '${RELAY_DAEMON_MARKER.trim()}' || true`

export function parseRelayDaemonRuntimes(output: string): Map<string, string> {
  const runtimes = new Map<string, string>()
  for (const line of output.split('\n')) {
    const marker = line.indexOf(RELAY_DAEMON_MARKER)
    const sock = /\s--sock-path\s+(\/\S+)/.exec(line)?.[1]
    const node = marker > 0 ? line.slice(0, marker).trim() : ''
    if (sock && node && !runtimes.has(sock)) {
      runtimes.set(sock, node)
    }
  }
  return runtimes
}

export async function readRelayDaemonRuntimes(
  conn: SshConnection,
  signal?: AbortSignal
): Promise<Map<string, string>> {
  try {
    return parseRelayDaemonRuntimes(
      await execCommand(conn, RELAY_DAEMON_ARGV_COMMAND, { wrapCommand: true, signal })
    )
  } catch {
    return new Map()
  }
}
