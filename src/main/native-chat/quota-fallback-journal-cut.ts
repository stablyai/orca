import type { StructuredAgentSessionCurrentWork } from './agent-session-wire/structured-agent-session-current-work'
import type { StructuredAgentSessionHostDeps } from './agent-session-wire/structured-agent-session-host-types'
import type { AgentSessionJournal } from './agent-session-journal/journal-store'
import { readAgentSessionFailureFact } from '../../shared/agent-session/failures/agent-session-failure'
import { latestNativeChatUsageLimitCut } from '../../shared/native-chat/native-chat-usage-limit-cut'
import { findInNativeChatTurn } from '../../shared/native-chat/native-chat-orca-stop-cut'
import { isRootAgentJournalItem } from '../../shared/agent-session/journal/agent-session-journal-producer'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../shared/agent-session/journal/agent-session-journal-types'

export type ConfirmedQuotaCut = {
  sessionId: string
  turnItemId: string
  errorCode: 'usage_limit_reached' | 'usageLimitExceeded'
}

export function confirmedQuotaCut(
  sessionId: string,
  items: readonly AgentJournalRenderItem[],
  submissions: readonly Pick<AgentJournalSubmission, 'dispatchState'>[]
): ConfirmedQuotaCut | null {
  const cut = latestNativeChatUsageLimitCut(items, submissions)
  if (!cut) {
    return null
  }
  const errorCode = findInNativeChatTurn(items, cut.turnItemId, (item) => {
    if (!isRootAgentJournalItem(item) || item.body.kind !== 'status') {
      return null
    }
    const failure = readAgentSessionFailureFact(item.body.failure)
    return failure?.kind === 'usageLimitReached' ? (failure.usageLimit?.providerCode ?? null) : null
  })
  return errorCode ? { sessionId, turnItemId: cut.turnItemId, errorCode } : null
}

export function observeConfirmedQuotaCut(
  deps: StructuredAgentSessionHostDeps,
  sessionId: string,
  journal: AgentSessionJournal,
  work: StructuredAgentSessionCurrentWork,
  childrenPending: boolean
): void {
  const observer = deps.onConfirmedQuotaCut
  if (
    !observer ||
    work.working() ||
    work.owesAnySend() ||
    work.hasActionablePrompt() ||
    childrenPending
  ) {
    return
  }
  const snapshot = journal.snapshot()
  const cut = confirmedQuotaCut(sessionId, snapshot.items, snapshot.submissions)
  if (!cut) {
    return
  }
  const failed = () =>
    deps.logger.warn('quota fallback observer failed', {
      scope: 'quota-fallback',
      sessionId
    })
  try {
    void Promise.resolve(observer(cut)).catch(failed)
  } catch {
    failed()
  }
}
