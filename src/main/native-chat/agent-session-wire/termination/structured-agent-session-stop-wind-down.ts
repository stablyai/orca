import type { AgentSessionStopOutcome } from '../providers/structured-agent-session-adapter-stop'
import { agentSessionFailureFact } from '../../../../shared/agent-session/failures/agent-session-failure'
import { agentSessionFailureWords } from '../../../../shared/agent-session/failures/agent-session-failure-words'
import { agentJournalItemKey } from '../../../../shared/agent-session/journal/agent-session-journal-item-key'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalItemBody
} from '../../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentJournalItemIdentity } from '../../../../shared/agent-session/journal/agent-session-journal-identity'
import { readContextStructuredAgentSessionTurn } from '../observations/structured-agent-session-read-work'
import type { AgentSessionTurnContext } from '../operations/structured-agent-session-turns'
import type { JournalStopFailedOn } from '../../agent-session-journal/queued-messages/queued-message-pause-marks'
import { structuredAgentSessionStopNoteIdentity } from '../operations/structured-agent-session-command-turn'

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
  ctx: Pick<
    AgentSessionTurnContext,
    'sessionId' | 'adapter' | 'journal' | 'fence' | 'currentWork' | 'readWork'
  >,
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
    const { activeTurnId } = await readContextStructuredAgentSessionTurn(ctx)
    failedOn =
      activeTurnId !== null
        ? { turnId: activeTurnId }
        : { openedAfter: ctx.journal.cursor().sequence }
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
  ctx: Pick<AgentSessionTurnContext, 'journal' | 'fence' | 'currentWork' | 'readWork'>,
  identity: AgentJournalItemIdentity
): Promise<void> {
  const live = await readContextStructuredAgentSessionTurn(ctx)
  if (!live.working) {
    return
  }
  const itemId = agentJournalItemKey(identity)
  const written = await ctx.journal.reads.item(itemId)
  if (written === null) {
    return
  }
  const body: AgentJournalItemBody = {
    kind: 'status',
    ...agentSessionFailureWords(agentSessionFailureFact('cancelUnconfirmed'), { surface: 'row' })
  }
  // Row scopes are immutable: atomically rekey a turnless note onto running work so its proven end finds it.
  // With no open turn, key/scope stay unchanged and no turn end revises it.
  const running = live.activeTurnId
  const turnScope = live.turnScope.kind === 'turn' ? live.turnScope : null
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
