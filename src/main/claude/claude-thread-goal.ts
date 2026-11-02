// Claude's `/goal`, read into the journal's typed goal transition so readers see it as they see
// Codex's. Stream-json reports a goal only in words: a root `<synthetic>` reply to the command
// ("Goal set: …", "Goal active: … (2 turns)", "Goal cleared: …", "No goal set"). Its
// `active_goal` event never reaches stream-json, and meeting the goal sends no frame at all.

import type {
  AgentJournalItemBody,
  AgentJournalItemIdentity,
  AgentJournalThreadGoal
} from '../../shared/agent-session-journal-types'
import {
  boundInlineText,
  DEFAULT_JOURNAL_PAYLOAD_LIMITS
} from '../native-chat/agent-session-journal/journal-payload-bounds'
import { claudeRecord, claudeText } from './claude-structured-item-translation'
import { isRootClaudeFrame } from './claude-turn-opening'
import type { ClaudeGoalBackgroundWork } from './claude-background-task-tracker'

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
  // Also "Goal cleared after an unrecoverable error (…)", which the CLI sends on its own.
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
    threadGoal: goal
      ? {
          state: 'set',
          goal: {
            ...goal,
            objective: boundInlineText(goal.objective, DEFAULT_JOURNAL_PAYLOAD_LIMITS).text
          }
        }
      : { state: 'cleared' }
  }
}

type GoalRowWrite = { identity: AgentJournalItemIdentity; body: GoalStatusBody }
type SavedGoal = {
  goal: AgentJournalThreadGoal | null
  row: { identity: AgentJournalItemIdentity; text: string } | null
}

export class ClaudeThreadGoal {
  /** Undefined until first needed: the journal answers for goals set before this process. */
  private known: AgentJournalThreadGoal | null | undefined
  /** The row this process wrote for the goal, which a turn's time revises in place. */
  private row: { identity: AgentJournalItemIdentity; text: string } | null = null
  /** Whether the model worked toward the active goal in the open turn. */
  private modelWorked = false

  /** `journalGoal` answers undefined until the sink is bound to its journal. */
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

  /** The goal row a root reply to `/goal` becomes, in place of assistant prose; null otherwise. */
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

  /** Root model output: a turn the goal's Stop hook will judge before Claude ends it. */
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

  /**
   * What a root result writes for the goal, or null. With a goal set, Claude ends a turn on its
   * own only once the goal's Stop hook passes, so a clean end after model work means the goal was
   * met. It defers that check while background work runs, and a person's Stop during the check
   * still ends the turn cleanly. Any of those, or any other end (a turn cap, an error), leaves
   * the goal open: its row only gains the turn's time, counted as the banner counts it, from the
   * later of the goal's last update and the turn's start.
   */
  settle(
    result: Record<string, unknown>,
    end: {
      backgroundWork: ClaudeGoalBackgroundWork
      stoppedByPerson: boolean
      turnStartedAt: number | null
    },
    observedAt: number
  ): GoalRowWrite | null {
    // A subagent's result ends no turn.
    if (!isRootClaudeFrame(result)) {
      return null
    }
    const goal = this.current
    const worked = this.modelWorked
    this.modelWorked = false
    // A command answered with no model turn (a bare `/goal`) spent no time on the goal.
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
      end.backgroundWork === 'exited' &&
      !end.stoppedByPerson
    const next: AgentJournalThreadGoal = {
      ...goal,
      status: met ? 'complete' : 'active',
      timeUsedSeconds: goal.timeUsedSeconds + Math.max(0, Math.floor((observedAt - since) / 1000)),
      updatedAt: observedAt
    }
    this.known = next
    if (met) {
      this.row = null
      return sessionId && uuid
        ? {
            identity: { provider: 'claude', sessionId, uuid: `${uuid}:goal` },
            body: goalRow(`Goal complete: ${goal.objective}`, next)
          }
        : null
    }
    // A restart recovers the original identity with the goal, so this revision stays in place.
    return this.row ? { identity: this.row.identity, body: goalRow(this.row.text, next) } : null
  }
}
