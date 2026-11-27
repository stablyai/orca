// Stream-json exposes /goal through synthetic replies; completion must be inferred.

import type {
  AgentJournalItemBody,
  AgentJournalThreadGoal
} from '../../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentJournalItemIdentity } from '../../../../shared/agent-session/journal/agent-session-journal-identity'
import {
  claudeMessageIdentity,
  claudeRecord,
  claudeText,
  type ClaudeMessageEnvelope
} from './claude-structured-item-translation'
import { sliceAtCodeUnitLimit } from '../../../../shared/text/surrogate-safe-text-slice'
import { isRootClaudeFrame } from '../turns/claude-turn-opening'
import type { ClaudeGoalBackgroundWork } from '../../background-tasks/claude-background-task-tracker'

const GOAL_SET = 'Goal set: '
const SETTLED_ROW_SUFFIX = ':goal'
const GOAL_ACTIVE = /^Goal active: ([\s\S]+) \((?:not yet evaluated|\d+ turns?)\)$/u

type GoalStatusBody = Extract<AgentJournalItemBody, { kind: 'status' }>
type GoalReport = { kind: 'set'; objective: string } | { kind: 'cleared' }

function syntheticReplyText(message: Record<string, unknown>): string | null {
  const reply = claudeRecord(message.message)
  if (
    message.type !== 'assistant' ||
    !isRootClaudeFrame(message) ||
    reply?.model !== '<synthetic>'
  ) {
    return null
  }
  const content = Array.isArray(reply.content) ? reply.content : []
  return content
    .flatMap((part) => {
      const block = claudeRecord(part)
      return block?.type === 'text' && typeof block.text === 'string' ? [block.text] : []
    })
    .join('')
    .trim()
}

function goalReport(text: string): GoalReport | null {
  if (text.startsWith(GOAL_SET)) {
    const objective = text.slice(GOAL_SET.length).trim()
    return objective ? { kind: 'set', objective } : null
  }
  // Includes unsolicited "Goal cleared after an unrecoverable error (…)" replies.
  if (text.startsWith('Goal cleared') || text.startsWith('No goal set')) {
    return { kind: 'cleared' }
  }
  const active = GOAL_ACTIVE.exec(text)?.[1]
  return active ? { kind: 'set', objective: active } : null
}

function goalRow(text: string, goal: AgentJournalThreadGoal | null): GoalStatusBody {
  return {
    kind: 'status',
    text,
    threadGoal: goal ? { state: 'set', goal } : { state: 'cleared' }
  }
}

type GoalRowWrite = { identity: AgentJournalItemIdentity; body: GoalStatusBody }
type GoalRowRef = { identity: AgentJournalItemIdentity; text: string }

function settledRowIdentity(sessionId: string, uuid: string): AgentJournalItemIdentity {
  return claudeMessageIdentity({ sessionId, uuid: `${uuid}${SETTLED_ROW_SUFFIX}` })
}

/** Orca's own completion row, which later reopens and completions revise in place. */
function isSettledRow(row: GoalRowRef | null): row is GoalRowRef {
  return row?.identity.provider === 'claude' && row.identity.uuid.endsWith(SETTLED_ROW_SUFFIX)
}

/** A settled goal's row; with `stopped`, the writer picks and `adopt` records its reading. */
export type ClaudeGoalSettlement = {
  ran: GoalRowWrite | null
  stopped?: GoalRowWrite | null
  adopt?: (stopped: boolean) => void
}
type SavedGoal = {
  goal: AgentJournalThreadGoal | null
  row: GoalRowRef | null
}

export class ClaudeThreadGoal {
  /** Undefined defers hydration until the journal binds; null means no goal. */
  private known: AgentJournalThreadGoal | null | undefined
  private row: GoalRowRef | null = null
  private modelWorked = false

  constructor(private readonly journalGoal: () => SavedGoal | undefined) {}

  private get current(): AgentJournalThreadGoal | null {
    if (this.known === undefined) {
      const saved = this.journalGoal()
      if (saved) {
        this.known = saved.goal
        this.row = saved.row?.identity.provider === 'claude' ? saved.row : null
      }
    }
    return this.known ?? null
  }

  report(
    message: Record<string, unknown>,
    identity: AgentJournalItemIdentity,
    observedAt: number
  ): GoalStatusBody | null {
    const text = syntheticReplyText(message)
    const report = text ? goalReport(text) : null
    if (!text || !report) {
      return null
    }
    const current = this.current
    const next: AgentJournalThreadGoal | null =
      report.kind === 'cleared'
        ? null
        : current?.status === 'active' && current.objective === report.objective
          ? current
          : {
              objective: report.objective,
              status: 'active',
              tokenBudget: null,
              tokensUsed: 0,
              timeUsedSeconds: 0,
              createdAt: observedAt,
              updatedAt: observedAt
            }
    this.known = next
    this.row = next ? { identity, text } : null
    this.modelWorked = false
    return goalRow(text, next)
  }

  /** Match the goal's own Stop hook check; one after an inferred completion reopens the goal. */
  recordGoalCheck(
    envelope: ClaudeMessageEnvelope
  ): { reason: string; reopened: GoalRowWrite | null } | null {
    const goal = this.current
    const text = claudeText(claudeRecord(envelope.content[0])?.text)
    if (!goal || !text) {
      return null
    }
    const shortened = sliceAtCodeUnitLimit(goal.objective, 500)
    const labels = [goal.objective]
    if (shortened.length < goal.objective.length) {
      labels.push(`${shortened}… [+${goal.objective.length - shortened.length} chars]`)
    }
    const prefix = labels
      .map((label) => `Stop hook feedback:\n[${label}]: `)
      .find((value) => text.startsWith(value))
    if (!prefix) {
      return null
    }
    const reason = text.slice(prefix.length).trim()
    if (/\n\[[^\n]+\]: /u.test(reason)) {
      return null
    }
    if (goal.status !== 'complete') {
      return { reason, reopened: null }
    }
    // Completion is only inferred; revise the completion row so restarts and older clients see the reopen.
    const active: AgentJournalThreadGoal = { ...goal, status: 'active' }
    const row = {
      identity: isSettledRow(this.row)
        ? this.row.identity
        : settledRowIdentity(envelope.sessionId, envelope.uuid),
      text: `Goal active: ${goal.objective}`
    }
    this.known = active
    this.row = row
    return { reason, reopened: { identity: row.identity, body: goalRow(row.text, active) } }
  }

  observe(message: Record<string, unknown>): void {
    const reply = claudeRecord(message.message)
    if (
      message.type === 'assistant' &&
      isRootClaudeFrame(message) &&
      reply?.model !== '<synthetic>' &&
      this.current?.status === 'active'
    ) {
      this.modelWorked = true
    }
  }

  /** A clean model turn implies the goal's Stop hook passed unless stopped or backgrounded. */
  settle(
    result: Record<string, unknown>,
    end: {
      backgroundWork: ClaudeGoalBackgroundWork
      /** Whether a person's Stop could have decided the ending turn. */
      stoppable: boolean
      turnStartedAt: number | null
    },
    observedAt: number
  ): ClaudeGoalSettlement | null {
    if (!isRootClaudeFrame(result)) {
      return null
    }
    const goal = this.current
    const worked = this.modelWorked
    this.modelWorked = false
    // A bare /goal has no model time to charge.
    if (goal?.status !== 'active' || (!worked && result.num_turns === 0)) {
      return null
    }
    const since = Math.max(goal.updatedAt, end.turnStartedAt ?? goal.updatedAt)
    const sessionId = claudeText(result.session_id)
    const uuid = claudeText(result.uuid)
    const met =
      worked &&
      result.subtype === 'success' &&
      result.is_error !== true &&
      (result.terminal_reason === undefined || result.terminal_reason === 'completed') &&
      end.backgroundWork === 'exited'
    const reading = (status: 'complete' | 'active'): AgentJournalThreadGoal => ({
      ...goal,
      status,
      timeUsedSeconds: goal.timeUsedSeconds + Math.max(0, Math.floor((observedAt - since) / 1000)),
      updatedAt: observedAt
    })
    const active = reading('active')
    // Reuse the persisted row identity across restarts.
    const activeRow = this.row
      ? { identity: this.row.identity, body: goalRow(this.row.text, active) }
      : null
    this.known = active
    if (!met) {
      return { ran: activeRow }
    }
    const complete = reading('complete')
    const completeIdentity = isSettledRow(this.row)
      ? this.row.identity
      : sessionId && uuid
        ? settledRowIdentity(sessionId, uuid)
        : null
    const completeText = `Goal complete: ${goal.objective}`
    const completeRow = completeIdentity
      ? { identity: completeIdentity, body: goalRow(completeText, complete) }
      : null
    const adopt = (stopped: boolean) => {
      if (!stopped && this.known === active) {
        this.known = complete
        this.row = completeIdentity ? { identity: completeIdentity, text: completeText } : null
      }
    }
    if (!end.stoppable) {
      adopt(false)
      return { ran: completeRow }
    }
    return { ran: completeRow, stopped: activeRow, adopt }
  }
}
