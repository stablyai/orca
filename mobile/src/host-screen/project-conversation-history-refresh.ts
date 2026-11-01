import { AI_VAULT_CANONICAL_PROJECT_SEARCH_CAPABILITY } from '../../../src/shared/ai-vault-runtime-capabilities'
import type { RpcClient } from '../transport/rpc-client'
import {
  agentHistoryHostStatusRead,
  agentHistorySessionScan
} from '../agent-history/mobile-agent-history-operations'
import { readConversationHistory } from './conversation-records'

export type ProjectConversationHistorySnapshot = ReturnType<typeof readConversationHistory>

export async function refreshProjectConversationHistory(
  client: RpcClient,
  force: boolean,
  previous?: ProjectConversationHistorySnapshot
) {
  const status = agentHistoryHostStatusRead.interpret(
    await agentHistoryHostStatusRead.request(client)
  )
  const capabilities = status.capabilities ?? []
  if (!capabilities.includes('aiVault.v1')) {
    return { capabilities, history: null }
  }
  const request = {
    ...(capabilities.includes(AI_VAULT_CANONICAL_PROJECT_SEARCH_CAPABILITY)
      ? { historyOwnership: {} }
      : {}),
    unlimited: true,
    includeAntigravityIdeSessions: true,
    includeStructuredSessions: true,
    force
  }
  const afterFingerprint = force ? undefined : previous?.fingerprint
  const read = async (conditional: boolean) =>
    readConversationHistory(
      agentHistorySessionScan.interpret(
        await agentHistorySessionScan.request(client, {
          ...request,
          ...(conditional && afterFingerprint ? { afterFingerprint } : {})
        })
      )
    )
  let history = await read(true)
  if (history.unchanged) {
    if (previous && afterFingerprint && history.fingerprint === afterFingerprint) {
      return { capabilities, history: previous }
    }
    history = await read(false)
    if (history.unchanged) {
      throw new Error('Conversation history refresh did not return a full snapshot')
    }
  }
  return { capabilities, history }
}
