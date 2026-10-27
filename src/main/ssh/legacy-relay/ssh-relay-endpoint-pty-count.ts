/** Ask via the relay's own bridge/hash when process-table evidence is incomplete. pty.listProcesses needs no owner role and cannot take another desktop's PTYs. */
import type { SshConnection } from '../connection/ssh-connection'
import { SshChannelMultiplexer } from '../ssh-channel-multiplexer'
import { quotePosixShell } from '../../../shared/shell-argument-quoting'
import { SHORT_RELAY_SOCKET_DIR_PREFIX } from '../relay-socket-path-limit'
import { waitForSentinel } from './ssh-relay-sentinel'

const RELAY_PTY_COUNT_TIMEOUT_MS = 10_000

/** Null when the relay could not be asked or answered something that is not a listing. */
export async function countRelayEndpointPtys(
  conn: SshConnection,
  nodePath: string,
  sockPath: string,
  signal?: AbortSignal
): Promise<number | null> {
  const connectCommand = relayBridgeConnectCommand(nodePath, sockPath)
  return connectCommand ? countRelayPtysOverBridge(conn, connectCommand, signal) : null
}

/** Short /tmp sockets name no build; leave them unasked rather than guess the relay's own bridge directory. */
export function relayBridgeConnectCommand(nodePath: string, sockPath: string): string | null {
  const slash = sockPath.lastIndexOf('/')
  const relayDir = sockPath.slice(0, slash)
  const dirName = relayDir.slice(relayDir.lastIndexOf('/') + 1)
  if (
    slash <= 0 ||
    !dirName.startsWith('relay-') ||
    sockPath.startsWith(SHORT_RELAY_SOCKET_DIR_PREFIX)
  ) {
    return null
  }
  return (
    `cd ${quotePosixShell(relayDir)} && ${quotePosixShell(nodePath)} relay.js --connect ` +
    `--sock-path ${quotePosixShell(sockPath)} --credential-file ${quotePosixShell(`${sockPath}.credential`)}`
  )
}

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
