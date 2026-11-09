// Command output stays off the reply timeline; only the command's result ends its turn.

import type { AgentJournalItemBody } from '../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentJournalItemIdentity } from '../../shared/agent-session/journal/agent-session-journal-identity'
import { agentJournalItemKey } from '../../shared/agent-session/journal/agent-session-journal-item-key'
import {
  providerDiagnostic,
  type ProviderDiagnostic
} from '../../shared/agent-session/failures/agent-session-failure'
import { agentSessionFailureWords } from '../../shared/agent-session/failures/agent-session-failure-words'
import { TUI_AGENT_DISPLAY_NAMES } from '../../shared/agent-launch/catalog/tui-agent-display-names'
import type { StructuredAgentSessionCommandRun } from '../native-chat/agent-session-wire/providers/structured-agent-session-adapter'
import { structuredCompactionOutcome } from '../native-chat/agent-session-wire/operations/structured-conversation-command-outcome'
import { claudeText } from './structured/journal/claude-structured-item-translation'
import { claudeResultFailure } from './structured/launch/claude-structured-provider-fallback'
import type { ClaudeCurrentTurn, ClaudeTurnEnd } from './claude-turn-lifecycle-item'
import { isRootClaudeFrame } from './claude-turn-opening'
import type { ClaudeOpenTurn } from './claude-open-turn'
import type { ClaudeUsageLimits } from './claude-usage-limits'
import type { ClaudeAssistantFailures } from './claude-assistant-failures'

export type ClaudeCommandTurn = {
  identity: AgentJournalItemIdentity
  resultIdentity: AgentJournalItemIdentity
  sentUuid: string
  compacted: boolean
  interruptRequested: boolean
  failed: { detail?: ProviderDiagnostic } | null
  /** Limits that rejected this command while it ran; older account rejections cannot explain it. */
  rejections: Set<string>
  /** The hidden reply's sign-in notice, written only if the command's failure selects it. */
  notice: AgentJournalItemBody | null
}

export type ClaudeCommandStart = StructuredAgentSessionCommandRun & {
  providerSessionId: string
  sentUuid: string
}

export function claudeCommandCurrentTurn(start: ClaudeCommandStart): ClaudeCurrentTurn {
  const { running } = start
  return {
    sessionId: start.providerSessionId,
    turnId: start.turnId,
    startedAt: running.startedAt ?? Date.now(),
    ...(running.requestedAt === undefined ? {} : { requestedAt: running.requestedAt }),
    userItemId: running.userItemId ?? agentJournalItemKey(start.identity),
    command: {
      identity: start.identity,
      resultIdentity: start.resultIdentity,
      sentUuid: start.sentUuid,
      compacted: false,
      interruptRequested: false,
      failed: null,
      rejections: new Set(),
      notice: null
    }
  }
}

/** Return true for command output that must stay off the reply timeline. */
export function observeClaudeCommandFrame(
  command: ClaudeCommandTurn | null,
  message: Record<string, unknown>
): boolean {
  if (!command) {
    return false
  }
  if (message.type === 'system') {
    // A success status precedes compaction; only the boundary confirms history replacement.
    if (message.subtype === 'compact_boundary') {
      command.compacted = true
    } else if (message.compact_result === 'failed') {
      const words = claudeText(message.compact_error)
      const detail = words === null ? undefined : providerDiagnostic(words, 'person')
      command.failed = detail ? { detail } : {}
    }
    return false
  }
  return (
    isRootClaudeFrame(message) &&
    (message.type === 'user' || message.type === 'assistant' || message.type === 'stream_event')
  )
}

/** Hidden command replies still carry this attempt's provider failure cause. */
export function absorbClaudeCommandFrame(
  {
    turn,
    usageLimits,
    assistantFailures
  }: {
    turn: ClaudeOpenTurn
    usageLimits: Pick<ClaudeUsageLimits, 'assistant'>
    assistantFailures: Pick<ClaudeAssistantFailures, 'notice'>
  },
  message: Record<string, unknown>
): boolean {
  const { command } = turn
  if (!observeClaudeCommandFrame(command, message)) {
    return false
  }
  if (command && claudeCommandAnswers(command, message)) {
    usageLimits.assistant(message, turn)
    command.notice ??= assistantFailures.notice(message)
  }
  return true
}

/** Frames without an input UUID predate correlation; one naming another input is not this command's. */
function claudeCommandAnswers(
  command: ClaudeCommandTurn,
  message: Record<string, unknown>
): boolean {
  const answers = claudeText(message.user_message_uuid)
  return answers === null || answers === command.sentUuid
}

export function claudeCommandEnd(
  command: ClaudeCommandTurn,
  message: Record<string, unknown>,
  completedAt: number
): { end: ClaudeTurnEnd; row: AgentJournalItemBody | null } | null {
  if (!claudeCommandAnswers(command, message)) {
    return null
  }
  // Stopped and finished compactions can both return success; use compaction evidence.
  const shown = claudeResultFailure(message)
  const verdict = structuredCompactionOutcome({
    compacted: command.compacted,
    interruptRequested: command.interruptRequested,
    failed: command.failed ?? (shown ? {} : null)
  })
  const durationMs = message.duration_ms
  const end: ClaudeTurnEnd = {
    state: verdict.outcome === 'cancellation' ? 'interrupted' : 'completed',
    completedAt,
    outcome: verdict.outcome,
    ...(typeof durationMs === 'number' && Number.isFinite(durationMs) && durationMs >= 0
      ? { durationMs }
      : {})
  }
  if (verdict.outcome === 'success') {
    return { end, row: { kind: 'status', text: 'Context compacted', presentation: 'compaction' } }
  }
  // Provider fallback already renders error results.
  return verdict.failure && !shown
    ? {
        end,
        row: {
          kind: 'status',
          ...agentSessionFailureWords(verdict.failure, {
            surface: 'row',
            agentName: TUI_AGENT_DISPLAY_NAMES.claude
          }),
          tone: 'error'
        }
      }
    : { end, row: null }
}
