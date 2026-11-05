import type { AgentSessionConversationView } from '../../../shared/agent-session/lifecycle/agent-session-conversation-view'
import { agentSessionProviderHandleChainHead } from '../../../shared/agent-session/lifecycle/agent-session-provider-handle'
import type { AgentProviderSessionMetadata } from '../../../shared/agent-session/lifecycle/agent-session-resume'
import type {
  AgentSessionHistoryRequest,
  AgentSessionHistoryResult
} from '../../../shared/agent-session/agent-session-wire'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import type { HistoryReader } from './agent-session-history-page-bounds'
import {
  readAgentSessionHistory,
  type AgentSessionHistoryScope
} from './agent-session-history-page'
import {
  withPublishedWorkResult,
  capturePublishedWork,
  capturePublishedWorkSteps,
  type AgentSessionPublishedWork
} from './agent-session-published-work'

export function structuredAgentSessionProviderSessionMetadata(
  record: AgentSessionConversationView | null
): AgentProviderSessionMetadata | undefined {
  const head = record ? agentSessionProviderHandleChainHead(record.providerHandleChain) : null
  return head ? { key: 'session_id', id: head.handle.nativeId } : undefined
}

export function readStructuredAgentSessionHistoryResult(input: {
  journal: AgentSessionJournal
  record: AgentSessionConversationView | null
  request: AgentSessionHistoryRequest
  scope?: AgentSessionHistoryScope
  reader?: HistoryReader
  replaceNormalizedHistory?: boolean
  /** The host's current-work projection, which the page's turn and prompt fields state. */
  work?: AgentSessionPublishedWork
}): AgentSessionHistoryResult | Promise<AgentSessionHistoryResult> {
  return readAgentSessionHistory(input.journal, input.request, {
    scope: input.scope,
    reader: input.reader,
    rowReplay: input.replaceNormalizedHistory === false,
    captureResult: (snapshot) => decorate(capturePublishedWork(snapshot, input.work)),
    captureResultSteps: function* (snapshot) {
      for (;;) {
        const work = input.work
        const captured = yield* capturePublishedWorkSteps(snapshot, work)
        const next = input.work
        if (work?.viewKey() === next?.viewKey() && work?.revision === next?.revision) {
          return decorate(captured)
        }
        yield
      }
    }
  })

  function decorate(work: AgentSessionPublishedWork | undefined) {
    const fence = input.record?.currentFence
    const providerSession = structuredAgentSessionProviderSessionMetadata(input.record)
    return (read: AgentSessionHistoryResult) => {
      const result = withPublishedWorkResult(read, work)
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
  }
}
