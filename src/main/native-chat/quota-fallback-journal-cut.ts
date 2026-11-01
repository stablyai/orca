import type { StructuredAgentSessionCurrentWork } from './agent-session-wire/structured-agent-session-current-work'
import type { StructuredAgentSessionHostDeps } from './agent-session-wire/structured-agent-session-host-types'
import type { AgentSessionJournal } from './agent-session-journal/journal-store'
import { StructuredAgentSessionJournalObservers } from './agent-session-wire/structured-agent-session-journal-observers'
import type { AgentJournalCursor } from '../../shared/agent-session/journal/agent-session-journal-identity'
import { readAgentSessionFailureFact } from '../../shared/agent-session/failures/agent-session-failure'
import { latestNativeChatUsageLimitCut } from '../../shared/native-chat/native-chat-usage-limit-cut'
import { findInNativeChatTurn } from '../../shared/native-chat/native-chat-orca-stop-cut'
import { isRootAgentJournalItem } from '../../shared/agent-session/journal/agent-session-journal-producer'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../shared/agent-session/journal/agent-session-journal-types'

export const HELD_QUOTA_CUT_RETRY_INTERVAL_MS = 15_000

export type ConfirmedQuotaCut = {
  sessionId: string
  turnItemId: string
  errorCode: 'usage_limit_reached' | 'usageLimitExceeded'
}

export class HeldQuotaCutRetryTracker {
  private readonly held = new Map<
    string,
    { turnItemId: string; retryAt: number; cursor?: AgentJournalCursor }
  >()
  constructor(
    private readonly now: () => number,
    private readonly intervalMs: () => number | undefined
  ) {}
  hold(cut: ConfirmedQuotaCut, cursor?: AgentJournalCursor): void {
    const raw = this.intervalMs()
    const windowMs =
      raw !== undefined && Number.isFinite(raw)
        ? Math.max(0, raw)
        : HELD_QUOTA_CUT_RETRY_INTERVAL_MS
    if (windowMs <= 0) {
      this.held.delete(cut.sessionId)
      return
    }
    this.held.set(cut.sessionId, {
      turnItemId: cut.turnItemId,
      retryAt: this.now() + windowMs,
      cursor
    })
  }
  isHeld(sessionId: string, turnItemId: string, cursor?: AgentJournalCursor): boolean {
    const entry = this.held.get(sessionId)
    if (!entry || entry.turnItemId !== turnItemId) {
      return false
    }
    if (this.now() >= entry.retryAt) {
      this.held.delete(sessionId)
      return false
    }
    if (cursor) {
      entry.cursor = cursor
    }
    return true
  }
  shouldInspect(sessionId: string, cursor: AgentJournalCursor): boolean {
    const entry = this.held.get(sessionId)
    if (!entry) {
      return true
    }
    if (this.now() >= entry.retryAt) {
      this.held.delete(sessionId)
      return true
    }
    return (
      !entry.cursor ||
      entry.cursor.epoch !== cursor.epoch ||
      entry.cursor.sequence !== cursor.sequence
    )
  }
  delete(sessionId: string): void {
    this.held.delete(sessionId)
  }
  clear(): void {
    this.held.clear()
  }
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

type QuotaCutDeliveryState = {
  readCurrentWork: (sessionId: string) => StructuredAgentSessionCurrentWork | null
  childWorkOpen: (sessionId: string) => boolean
  childWorkIncomplete: (sessionId: string) => boolean
}

export function createQuotaJournalObservers(
  deps: () => StructuredAgentSessionHostDeps,
  delivery: QuotaCutDeliveryState
): StructuredAgentSessionJournalObservers {
  const observers = new StructuredAgentSessionJournalObservers((sessionId, error) =>
    deps().logger.warn('observing a journal publication failed', {
      scope: 'journal-delivery',
      sessionId,
      error
    })
  )
  const publish = observers.publish.bind(observers)
  observers.publish = (sessionId: string, journal: AgentSessionJournal): void => {
    observeConfirmedQuotaCut(deps(), sessionId, journal, delivery)
    publish(sessionId, journal)
  }
  return observers
}

export function observeConfirmedQuotaCut(
  deps: StructuredAgentSessionHostDeps,
  sessionId: string,
  journal: AgentSessionJournal,
  delivery: QuotaCutDeliveryState
): void {
  const observer = deps.onConfirmedQuotaCut
  const work = observer ? delivery.readCurrentWork(sessionId) : null
  if (
    !observer ||
    !work ||
    work.working() ||
    work.owesAnySend() ||
    work.hasActionablePrompt() ||
    delivery.childWorkOpen(sessionId) ||
    delivery.childWorkIncomplete(sessionId)
  ) {
    return
  }
  const cursor = journal.cursor()
  if (deps.quotaFallbackShouldInspect?.(sessionId, cursor) === false) {
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
    void Promise.resolve(observer(cut, cursor)).catch(failed)
  } catch {
    failed()
  }
}
