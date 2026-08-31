import type { CodexAppServerConnection } from './codex-app-server-connection-types'

const HANDSHAKE_TIMEOUT_MS = 15_000

export async function initializeCodexAppServerConnection(
  connection: CodexAppServerConnection
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
    { timeoutMs: HANDSHAKE_TIMEOUT_MS }
  )
  connection.notify('initialized')
}
