import type { AgentSessionStopOutcome } from './structured-agent-session-adapter-stop'
import { agentSessionFailureFact } from '../../../shared/agent-session-failure'
import { agentSessionFailureWords } from '../../../shared/agent-session-failure-words'
import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalItemBody,
  type AgentJournalItemIdentity,
  type AgentJournalTurnScope
} from '../../../shared/agent-session-journal-types'
import { isMainAgentWorking } from './structured-agent-session-turns-cancel'
import { contextStructuredAgentSessionCurrentWork } from './structured-agent-session-current-work'
import type { AgentSessionTurnContext } from './structured-agent-session-turns'
import type { JournalStopFailedOn } from '../agent-session-journal/queued-message-pause'
import { structuredAgentSessionFailedStopMark } from './structured-agent-session-stopping'
import { structuredAgentSessionStopNoteIdentity } from './structured-agent-session-command-turn'
import { structuredAgentSessionNamedTurnScope } from './structured-agent-session-turn-stop-notes'

/** Queued immediately behind Stop, so no later turn can intervene; wait only for an accepted interrupt. */
export type StructuredAgentSessionStopWindDown = {
  outcome?: AgentSessionStopOutcome
  operationId: string
  feedbackId?: string
  noteFence?: () => number
  waitsForProvider: boolean
  stoppedAt: number
  stopNote: AgentJournalItemIdentity
  stopNoteWrite?: Promise<void>
  /** End settlement regardless of exit proof; failedOn identifies work still running. */
  settled?: (failedOn?: JournalStopFailedOn) => void
}

/** Queue in the Stop’s tick to exclude intervening input; failures revise its note.
 * Unproven closes retain the child, and later agent operations join that close. */
export async function endStoppedStructuredAgentSession(
  ctx: Pick<AgentSessionTurnContext, 'sessionId' | 'adapter' | 'journal' | 'fence' | 'currentWork'>,
  windDown: StructuredAgentSessionStopWindDown,
  stopChild: () => Promise<void>,
  onError: (error: unknown) => void
): Promise<void> {
  let failedOn: JournalStopFailedOn | undefined
  try {
    if (windDown.waitsForProvider) {
      await ctx.adapter
        .awaitStoppedRequestEnd?.(ctx.sessionId, windDown.stoppedAt)
        .catch((error: unknown) => {
          if (windDown.outcome?.errors.length === 0) {
            windDown.outcome.errors.push(error)
          }
          onError(error)
        })
    }
    await stopChild()
    await windDown.stopNoteWrite?.catch(onError)
  } catch (error) {
    onError(error)
    if (windDown.outcome?.errors.length === 0) {
      windDown.outcome.errors.push(error)
    }
    failedOn = structuredAgentSessionFailedStopMark(
      contextStructuredAgentSessionCurrentWork(ctx),
      ctx.journal
    )
    await windDown.stopNoteWrite?.catch(onError)
    if (!windDown.outcome) {
      await reviseStopNoteUnconfirmed(ctx, windDown.stopNote).catch(onError)
    }
  } finally {
    windDown.settled?.(failedOn)
  }
  const outcome = windDown.outcome
  const writerStopped =
    outcome?.root === 'exited' || outcome?.deathEvidenceKind === 'kill-delivered'
  if (
    outcome &&
    (outcome.errors.length > 0 ||
      outcome.pause === 'unconfirmed' ||
      outcome.interrupt === 'unconfirmed' ||
      !writerStopped ||
      outcome.workload !== 'exited')
  ) {
    // Thread-scoped operation feedback survives generic turn-end rekeying and turnless shutdown.
    const identity = structuredAgentSessionStopNoteIdentity(
      windDown.feedbackId ?? windDown.operationId
    )
    await ctx.journal.appendLifecycleBatch({
      settlementId: `stop-outcome:${windDown.operationId}`,
      fence: Math.max(ctx.fence, windDown.noteFence?.() ?? ctx.fence),
      mutations: [
        ...(agentJournalItemKey(identity) === agentJournalItemKey(windDown.stopNote)
          ? []
          : [{ kind: 'tombstone' as const, identity: windDown.stopNote }]),
        {
          kind: 'item',
          identity,
          turnScope: AGENT_JOURNAL_THREAD_SCOPE,
          body: {
            kind: 'status',
            tone: 'warning',
            ...agentSessionFailureWords(agentSessionFailureFact('cancelUnconfirmed'), {
              surface: 'row',
              stopNotice:
                outcome.pause === 'unconfirmed' &&
                outcome.interrupt !== 'unconfirmed' &&
                writerStopped &&
                outcome.workload === 'exited'
                  ? 'pauseUnconfirmed'
                  : 'stopUnconfirmed'
            })
          }
        }
      ]
    })
  }
}

/** Revise only while work runs; ended work took the Stop regardless of child exit. */
async function reviseStopNoteUnconfirmed(
  ctx: Pick<AgentSessionTurnContext, 'journal' | 'fence' | 'currentWork'>,
  identity: AgentJournalItemIdentity
): Promise<void> {
  if (!isMainAgentWorking(ctx)) {
    return
  }
  const itemId = agentJournalItemKey(identity)
  let written: { turnScope?: AgentJournalTurnScope } | undefined
  ctx.journal.visitItemsWithLinkage((id, _sequence, _body, linkage) => {
    if (id === itemId) {
      written = linkage
    }
  })
  if (written === undefined) {
    return
  }
  const body: AgentJournalItemBody = {
    kind: 'status',
    ...agentSessionFailureWords(agentSessionFailureFact('cancelUnconfirmed'), { surface: 'row' })
  }
  // Row scopes are immutable: atomically rekey a turnless note onto running work so its proven end finds it.
  // With no open turn, key/scope stay unchanged and no turn end revises it.
  const running = contextStructuredAgentSessionCurrentWork(ctx).activeTurnId()
  const turnScope =
    running !== null ? structuredAgentSessionNamedTurnScope(ctx.journal, running) : null
  const onTurn = running !== null ? structuredAgentSessionStopNoteIdentity(running) : identity
  if (turnScope && agentJournalItemKey(onTurn) !== itemId) {
    await ctx.journal.appendLifecycleBatch({
      settlementId: `stop-note-on-turn:${itemId}`,
      fence: ctx.fence,
      mutations: [
        { kind: 'tombstone', identity },
        { kind: 'item', identity: onTurn, body, turnScope }
      ]
    })
    return
  }
  await ctx.journal.appendItem(identity, body, {
    fence: ctx.fence,
    turnScope: written.turnScope ?? AGENT_JOURNAL_THREAD_SCOPE
  })
}
