import type { AiVaultListResult } from '../../shared/ai-vault-types'
import type { RemoteScannerContext } from './remote-session-scanner-types'
import { restampAiVaultListResult } from './session-list-results'

export async function scanRemoteMimoSessions(
  args: Pick<RemoteScannerContext, 'provider' | 'executionHostId' | 'hostPlatform' | 'signal'> & {
    remoteHome: string
    limit: number
    reportUnsupported: boolean
  }
): Promise<AiVaultListResult> {
  if (!args.provider.scanMimoSessions) {
    return {
      sessions: [],
      issues: args.reportUnsupported
        ? [
            {
              agent: 'mimo-code',
              kind: 'scope',
              path: args.remoteHome,
              message:
                'MiMo history requires a relay with host-side SQLite support. Update the remote relay and use a Node.js runtime with node:sqlite support.'
            }
          ]
        : [],
      scannedAt: new Date().toISOString()
    }
  }
  const result = restampAiVaultListResult(
    await args.provider.scanMimoSessions({
      remoteHome: args.remoteHome,
      limit: args.limit,
      signal: args.signal
    }),
    args.executionHostId
  )
  return {
    ...result,
    sessions: result.sessions.map((session) => ({
      ...session,
      executionHostPlatform: args.hostPlatform.os
    }))
  }
}
