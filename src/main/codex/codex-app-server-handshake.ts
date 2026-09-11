import type { CodexAppServerConnection } from './codex-app-server-connection-types'

const HANDSHAKE_TIMEOUT_MS = 15_000

/** Returns the `initialize` result, which carries the CODEX_HOME the server
 *  itself resolved — the only wrapper-aware answer available to a caller. */
export async function initializeCodexAppServerConnection(
  connection: Pick<CodexAppServerConnection, 'request' | 'notify'>
): Promise<unknown> {
  const result = await connection.request(
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
    { timeoutMs: HANDSHAKE_TIMEOUT_MS }
  )
  connection.notify('initialized')
  return result
}
