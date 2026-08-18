import type { AiVaultListResult } from '../shared/ai-vault-types'
import { LOCAL_EXECUTION_HOST_ID } from '../shared/execution-host'
import { mergeAiVaultListResults } from '../main/ai-vault/session-list-results'
import { scanCursorSessionsOnOwningHost } from '../main/ai-vault/session-scanner-cursor-owning-host'
import { scanRemoteAiVaultSessions } from '../main/ai-vault/remote-session-scanner'
import type { RemoteSessionFilesystemProvider } from '../main/ai-vault/remote-session-scanner-types'
import type { RemoteHostPlatform } from '../main/ssh/ssh-remote-platform'

export async function scanRelayAiVaultSessions(args: {
  provider: RemoteSessionFilesystemProvider
  remoteHome: string
  hostPlatform: RemoteHostPlatform
  limit?: number
  unlimited?: boolean
  scopePaths?: readonly string[]
  signal?: AbortSignal
}): Promise<AiVaultListResult> {
  const nonCursor = await scanRemoteAiVaultSessions({
    ...args,
    executionHostId: LOCAL_EXECUTION_HOST_ID,
    includeCursorLegacy: false
  })
  const cursor = await scanCursorSessionsOnOwningHost({
    executionHostId: LOCAL_EXECUTION_HOST_ID,
    remoteHome: args.remoteHome,
    hostPlatform: args.hostPlatform,
    limit: args.limit,
    unlimited: args.unlimited,
    scopePaths: args.scopePaths,
    signal: args.signal
  })
  return mergeAiVaultListResults([nonCursor, cursor], args.limit, args.unlimited)
}
