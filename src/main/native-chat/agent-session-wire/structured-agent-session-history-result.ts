import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import { agentSessionProviderHandleChainHead } from '../../../shared/agent-session-provider-handle'
import type { AgentProviderSessionMetadata } from '../../../shared/agent-session-resume'
import type {
  AgentSessionHistoryRequest,
  AgentSessionHistoryResult
} from '../../../shared/agent-session-wire'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import {
  readAgentSessionHistory,
  type AgentSessionHistoryScope,
  type AgentSessionPublishedWork
} from './agent-session-history-page'

export function structuredAgentSessionProviderSessionMetadata(
  record: AgentSessionRecord | null
): AgentProviderSessionMetadata | undefined {
  const head = record ? agentSessionProviderHandleChainHead(record.providerHandleChain) : null
  return head ? { key: 'session_id', id: head.handle.nativeId } : undefined
}

export function readStructuredAgentSessionHistoryResult(input: {
  journal: AgentSessionJournal
  record: AgentSessionRecord | null
  request: AgentSessionHistoryRequest
  scope?: AgentSessionHistoryScope
  /** The host's current-work projection, which the page's turn and prompt fields state. */
  work?: AgentSessionPublishedWork
}): AgentSessionHistoryResult {
  const result = readAgentSessionHistory(
    input.journal,
    input.request,
    undefined,
    input.scope,
    input.work
  )
  const fence = input.record?.lease.runtimeFence
  const providerSession = structuredAgentSessionProviderSessionMetadata(input.record)
  if (fence === undefined) {
    return providerSession ? { ...result, providerSession } : result
  }
  return {
    ...result,
    page: { ...result.page, fence },
    ...(result.ok ? {} : { fence }),
    ...(providerSession ? { providerSession } : {})
  }
}
