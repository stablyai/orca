import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import { agentSessionProviderHandleChainHead } from '../../../shared/agent-session-provider-handle'
import type { AgentProviderSessionMetadata } from '../../../shared/agent-session-resume'
import type {
  AgentSessionHistoryRequest,
  AgentSessionHistoryResult
} from '../../../shared/agent-session-wire'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import { readAgentSessionHistory } from './agent-session-history-page'

function providerSessionMetadata(
  record: AgentSessionRecord | null
): AgentProviderSessionMetadata | undefined {
  const head = record ? agentSessionProviderHandleChainHead(record.providerHandleChain) : null
  return head
    ? {
        key: 'session_id',
        id: head.handle.provider === 'claude' ? head.handle.sessionId : head.handle.threadId
      }
    : undefined
}

export function readStructuredAgentSessionHistoryResult(input: {
  journal: AgentSessionJournal
  record: AgentSessionRecord | null
  request: AgentSessionHistoryRequest
}): AgentSessionHistoryResult {
  const result = readAgentSessionHistory(input.journal, input.request)
  const fence = input.record?.lease.runtimeFence
  const providerSession = providerSessionMetadata(input.record)
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
