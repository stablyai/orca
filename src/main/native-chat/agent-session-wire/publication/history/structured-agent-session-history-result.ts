import { withForkMarker, type ForkMarker } from './agent-session-fork-marker'
import type { AgentSessionConversationView } from '../../../../../shared/agent-session/lifecycle/leases/agent-session-conversation-view'
import { agentSessionProviderHandleChainHead } from '../../../../../shared/agent-session/lifecycle/provider-handles/agent-session-provider-handle'
import type { AgentProviderSessionMetadata } from '../../../../../shared/agent-session/lifecycle/agent-session-resume'
import type {
  AgentSessionHistoryRequest,
  AgentSessionHistoryResult
} from '../../../../../shared/agent-session/agent-session-wire'
import type { SqlAgentSessionJournal as AgentSessionJournal } from '../../../agent-session-journal/journal-sql-store'
import type { HistoryReader } from './agent-session-history-page-bounds'
import {
  readAgentSessionHistoryFrame,
  type AgentSessionHistoryFrame,
  type AgentSessionHistoryScope
} from './agent-session-history-page'
import type { JournalDomainHistoryWork } from '../../../agent-session-journal/journal-domain-history-page'
import type { QueuePublication } from '../../delivery/structured-agent-session-queued-publication'
import {
  withPublishedWorkResult,
  type AgentSessionPublishedWork
} from '../../observations/agent-session-published-work'

export function structuredAgentSessionProviderSessionMetadata(
  record: AgentSessionConversationView | null
): AgentProviderSessionMetadata | undefined {
  const head = record ? agentSessionProviderHandleChainHead(record.providerHandleChain) : null
  return head ? { key: 'session_id', id: head.handle.nativeId } : undefined
}

/** Rows, the work overlaid on them and the queue, from one held command-lane position. */
export type StructuredAgentSessionHistoryFrameCapture = <T>(
  rows: (work: JournalDomainHistoryWork | undefined) => Promise<AgentSessionHistoryFrame<T>>
) => Promise<
  | {
      value: T
      work: AgentSessionPublishedWork | undefined
      queue?: { value: QueuePublication | undefined }
    }
  | undefined
>

/** Undefined when the capture was abandoned because live authority moved while it was read. */
export async function readStructuredAgentSessionHistoryResult(input: {
  journal: AgentSessionJournal
  record: AgentSessionConversationView | null
  request: AgentSessionHistoryRequest
  scope?: AgentSessionHistoryScope
  forkMarker?: ForkMarker
  reader?: HistoryReader
  replaceNormalizedHistory?: boolean
  capture: StructuredAgentSessionHistoryFrameCapture
}): Promise<
  { result: AgentSessionHistoryResult; queue?: { value: QueuePublication | undefined } } | undefined
> {
  const frame = await input.capture((work) =>
    readAgentSessionHistoryFrame(
      input.journal,
      input.request,
      {
        scope: input.scope,
        reader: withForkMarker(input.reader, () => input.forkMarker),
        rowReplay: input.replaceNormalizedHistory === false
      },
      work,
      true
    )
  )
  if (!frame) {
    return undefined
  }
  const result = withPublishedWorkResult(frame.value, frame.work)
  const queue = frame.queue ? { queue: frame.queue } : {}
  const fence = input.record?.currentFence
  const providerSession = structuredAgentSessionProviderSessionMetadata(input.record)
  if (fence === undefined) {
    return { result: providerSession ? { ...result, providerSession } : result, ...queue }
  }
  return {
    result: {
      ...result,
      page: { ...result.page, fence },
      ...(result.ok ? {} : { fence }),
      ...(providerSession ? { providerSession } : {})
    },
    ...queue
  }
}
