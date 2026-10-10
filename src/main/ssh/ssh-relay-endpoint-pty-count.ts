/**
 * Asks one relay on the host how many PTYs it runs, through that relay's own bridge.
 *
 * The incumbent probe can only guess from the process table, and an accepting relay whose
 * holders or children it cannot read looks the same whether it runs shells or none. The relay
 * itself knows: its own `relay.js --connect` presents its own build hash, so any client reaches it,
 * and `pty.listProcesses` needs no PTY owner role, so asking never takes over another desktop's.
 */
import type { SshConnection } from './ssh-connection'
import { SshChannelMultiplexer } from './ssh-channel-multiplexer'
import { legacyRelayBridge } from './ssh-legacy-relay-route'
import { waitForSentinel } from './ssh-relay-deploy-helpers'

const RELAY_PTY_COUNT_TIMEOUT_MS = 10_000

/** Null when the relay could not be asked or answered something that is not a listing. */
export async function countRelayEndpointPtys(
  conn: SshConnection,
  nodePath: string,
  sockPath: string,
  signal?: AbortSignal
): Promise<number | null> {
  const bridge = legacyRelayBridge(nodePath, sockPath)
  return bridge ? countRelayPtysOverBridge(conn, bridge.connectCommand, signal) : null
}

/** The same question over an already-built bridge command, such as a Windows relay's PowerShell. */
export async function countRelayPtysOverBridge(
  conn: SshConnection,
  connectCommand: string,
  signal?: AbortSignal,
  execOptions?: { wrapCommand: boolean }
): Promise<number | null> {
  let mux: SshChannelMultiplexer | null = null
  try {
    mux = new SshChannelMultiplexer(
      await waitForSentinel(await conn.exec(connectCommand, execOptions), signal)
    )
    const rows = await mux.request(
      'pty.listProcesses',
      { includeForegroundProcessEvidence: false },
      { timeoutMs: RELAY_PTY_COUNT_TIMEOUT_MS, signal }
    )
    return Array.isArray(rows) ? rows.length : null
  } catch {
    return null
  } finally {
    mux?.dispose()
  }
}
