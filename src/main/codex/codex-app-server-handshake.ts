import type { CodexAppServerConnection } from './codex-app-server-connection-types'

const HANDSHAKE_TIMEOUT_MS = 15_000

/** `timeoutMs`: a native chat's start passes the host's start ceiling, whose attempt owns when a
 *  start gives up; other callers keep the handshake's own bound. */
export async function initializeCodexAppServerConnection(
  connection: CodexAppServerConnection,
  timeoutMs = HANDSHAKE_TIMEOUT_MS
): Promise<void> {
  await connection.request(
    'initialize',
    {
      clientInfo: { name: 'orca_desktop', title: 'Orca', version: '0.0.0' },
      capabilities: {
        experimentalApi: true,
        requestAttestation: false,
        mcpServerOpenaiFormElicitation: false,
        extensions: {}
      }
    },
    { timeoutMs }
  )
  connection.notify('initialized')
}
