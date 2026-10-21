import type { CodexAppServerConnection } from './codex-app-server-connection-types'

/** The caller owns the bound; null leaves cancellation to its startup signal. */
export async function initializeCodexAppServerConnection(
  connection: CodexAppServerConnection,
  timeoutMs: number | null
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
