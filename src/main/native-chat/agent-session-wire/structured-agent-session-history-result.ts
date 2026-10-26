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
  type AgentSessionHistoryScope
} from './agent-session-history-page'
import {
  withPublishedWorkResult,
  type AgentSessionPublishedWork
} from './agent-session-published-work'

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
  replaceNormalizedHistory?: boolean
  /** The host's current-work projection, which the page's turn and prompt fields state. */
  work?: AgentSessionPublishedWork
}): AgentSessionHistoryResult {
  const result = withPublishedWorkResult(
    readAgentSessionHistory(input.journal, input.request, {
      scope: input.scope,
      rowReplay: input.replaceNormalizedHistory === false
    }),
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
