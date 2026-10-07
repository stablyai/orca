/**
 * The Node runtime each running relay daemon was started with, read from its own argv.
 *
 * A relay launches as `<node> relay.js --detached ... --sock-path <sock> ...`, where `<node>` is
 * its pinned runtime on ladder hosts (which often have no Node on PATH) or the host Node a legacy
 * relay resolved. Asking that relay, or probing its socket, with the same runtime is what keeps a
 * host with no PATH Node from reading every relay as unverifiable.
 */
import type { SshConnection } from './ssh-connection'
import { execCommand } from './ssh-relay-deploy-helpers'

const RELAY_DAEMON_MARKER = ' relay.js --detached '

/**
 * `-ww` keeps long argv untruncated on procps and BSD `ps`; BusyBox (Alpine) rejects those flags
 * but lists every process for plain `-o args`. No daemon prints nothing.
 */
export const RELAY_DAEMON_ARGV_COMMAND =
  `{ ps -eww -o args= 2>/dev/null || ps -o args= 2>/dev/null; } | ` +
  `grep -F -- '${RELAY_DAEMON_MARKER.trim()}' || true`

/** Socket path to the runtime its daemon runs on; a daemon whose argv does not parse is skipped. */
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
