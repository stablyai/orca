import type { AiVaultSession } from '../../../src/shared/ai-vault/contracts/ai-vault-types'
import { AI_VAULT_SINGLE_HOST_LIST_TIMEOUT_MS } from '../../../src/shared/ai-vault/contracts/ai-vault-types'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import { interpretOrThrowRefusalMessage } from '../transport/rpc/rpc-refusal-message'
import { translate } from '../i18n/mobile-i18n'
import { agentHistorySessionScan } from './mobile-agent-history-operations'

export async function refreshMobileHistorySession(
  client: RpcClient,
  selected: AiVaultSession
): Promise<AiVaultSession> {
  const reply = await agentHistorySessionScan.request(
    client,
    {
      force: true,
      unlimited: true,
      includeAntigravityIdeSessions: true,
      ...(selected.cwd ? { scopePaths: [selected.cwd], scopeOnly: true } : {})
    },
    { timeoutMs: AI_VAULT_SINGLE_HOST_LIST_TIMEOUT_MS }
  )
  const result = interpretOrThrowRefusalMessage(
    () => agentHistorySessionScan.interpret(reply),
    translate('agentHistory.resume.refreshFailed', 'Unable to refresh this session. Try again.')
  )
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Same host-owned rows and checked container as the history reader; provider vocabulary must survive newer hosts.
  const sessions = result.sessions as AiVaultSession[]
  const session = sessions.find(
    (row) => row?.id === selected.id && row.executionHostId === selected.executionHostId
  )
  if (!session) {
    if (result.issues.length > 0) {
      throw new Error(
        translate('agentHistory.resume.refreshFailed', 'Unable to refresh this session. Try again.')
      )
    }
    throw new Error(
      translate(
        'agentHistory.resume.sessionChanged',
        'This session is no longer available. Refresh history and choose it again.'
      )
    )
  }
  return session
}
