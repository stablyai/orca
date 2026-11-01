import { readAgentJournalTurn } from '../../shared/agent-session/lifecycle/agent-session-turn-record'
import type { StructuredAgentSessionHost } from './agent-session-wire/structured-agent-session-host'
import { confirmedQuotaCut, type ConfirmedQuotaCut } from './quota-fallback-journal-cut'
import type {
  StructuredAgentSessionHostDeps,
  StructuredAgentSessionHostSession
} from './agent-session-wire/structured-agent-session-host-types'
import type { StructuredAgentSessionCurrentWork } from './agent-session-wire/structured-agent-session-current-work'

type NativeQuotaLeaseContext = {
  deps: StructuredAgentSessionHostDeps
  sessions: ReadonlyMap<string, StructuredAgentSessionHostSession>
  serialize<T>(sessionId: string, run: () => Promise<T>): Promise<T>
  work(sessionId: string): StructuredAgentSessionCurrentWork | null
  childrenPending(sessionId: string): boolean
  stop(sessionId: string): Promise<void>
  wake(sessionId: string): void
}
export function createNativeQuotaLease(context: () => NativeQuotaLeaseContext) {
  function allowed(sessionId: string, sourceTurnId: string): boolean {
    const session = context().sessions.get(sessionId)
    if (!session) {
      return false
    }
    const journal = session.journal
    const turn = journal.snapshot().items.find((item) => item.itemId === sourceTurnId)
    const turnId = turn ? readAgentJournalTurn(turn.body)?.turnId : null
    return (
      journal.queuedMessages.userStopInForce() === null &&
      !journal.stopMarks.personStopDecides(turnId ?? null) &&
      !journal.stopMarks.personStopDecides(null)
    )
  }
  return {
    allowed,
    reserve: (cut: ConfirmedQuotaCut, reserve: () => void) => {
      const ctx = context()
      return ctx.serialize(cut.sessionId, async () => {
        const session = ctx.sessions.get(cut.sessionId)
        const record = ctx.deps.store.getRecord(cut.sessionId)
        const work = ctx.work(cut.sessionId)
        if (
          !allowed(cut.sessionId, cut.turnItemId) ||
          !session ||
          !record ||
          !work ||
          work.working() ||
          work.owesAnySend() ||
          work.hasActionablePrompt() ||
          ctx.childrenPending(cut.sessionId) ||
          record.conversationCommand ||
          record.lease.unreconciled ||
          record.lease.claimStatus === 'conflicted'
        ) {
          return null
        }
        const snapshot = session.journal.snapshot()
        const current = confirmedQuotaCut(cut.sessionId, snapshot.items, snapshot.submissions)
        if (
          !current ||
          current.turnItemId !== cut.turnItemId ||
          current.errorCode !== cut.errorCode
        ) {
          return null
        }
        if (!ctx.deps.store.getConversation(cut.sessionId)) {
          return null
        }
        await ctx.deps.assertNoTerminalWriter?.(record)
        if (
          !allowed(cut.sessionId, cut.turnItemId) ||
          !ctx.deps.store.getConversation(cut.sessionId)
        ) {
          return null
        }
        reserve()
        await ctx.stop(cut.sessionId)
        return ctx.deps.store.getConversation(cut.sessionId)?.currentFence ?? null
      })
    },
    finish: (sessionId: string, finish: () => void) => {
      const ctx = context()
      return ctx.serialize(sessionId, async () => {
        const work = ctx.work(sessionId)
        if (
          !work ||
          work.working() ||
          work.owesAnySend() ||
          work.hasActionablePrompt() ||
          ctx.childrenPending(sessionId)
        ) {
          return false
        }
        await ctx.stop(sessionId)
        finish()
        ctx.wake(sessionId)
        return true
      })
    }
  }
}

export function nativeQuotaLeaseForHost(host: StructuredAgentSessionHost) {
  return createNativeQuotaLease(() => {
    const ports = host.collaboratorsForTests()
    return {
      deps: host.deps,
      sessions: ports.sessions,
      serialize: ports.serialize,
      work: host.currentWork,
      childrenPending: (id) =>
        ports.clientDelivery.childWorkIncomplete(id) || ports.clientDelivery.childWorkOpen(id),
      stop: (id) => ports.lifetime.stopAgent(id, { cause: 'evict', resting: true }),
      wake: (id) => ports.conversationDelivery.loop.wake(id)
    }
  })
}
