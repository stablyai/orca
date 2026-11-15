// Stream-json exposes /goal through synthetic replies; completion must be inferred.

import type {
  AgentJournalItemBody,
  AgentJournalThreadGoal
} from '../../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentJournalItemIdentity } from '../../../../shared/agent-session/journal/agent-session-journal-identity'
import { claudeRecord, claudeText } from './claude-structured-item-translation'
import { isRootClaudeFrame } from '../turns/claude-turn-opening'
import type { ClaudeGoalBackgroundWork } from '../../background-tasks/claude-background-task-tracker'

const GOAL_SET = 'Goal set: '
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

/** A settled goal's row; with `stopped`, the writer picks and `adopt` records its reading. */
export type ClaudeGoalSettlement = {
  ran: GoalRowWrite | null
  stopped?: GoalRowWrite | null
  adopt?: (stopped: boolean) => void
}
type SavedGoal = {
  goal: AgentJournalThreadGoal | null
  row: { identity: AgentJournalItemIdentity; text: string } | null
}

export class ClaudeThreadGoal {
  /** Undefined defers hydration until the journal binds; null means no goal. */
  private known: AgentJournalThreadGoal | null | undefined
  private row: { identity: AgentJournalItemIdentity; text: string } | null = null
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
    const completeRow =
      sessionId && uuid
        ? {
            identity: { provider: 'claude' as const, sessionId, uuid: `${uuid}:goal` },
            body: goalRow(`Goal complete: ${goal.objective}`, complete)
          }
        : null
    const adopt = (stopped: boolean) => {
      if (!stopped && this.known === active) {
        this.known = complete
        this.row = null
      }
    }
    if (!end.stoppable) {
      adopt(false)
      return { ran: completeRow }
    }
    return { ran: completeRow, stopped: activeRow, adopt }
  }
}
