// A conversation command Claude runs as the session's open turn. The turn is the host's record, and
// the command's own result ends it. Everything Claude writes for the command meanwhile — the
// summary it continues from, the command's echo, a "Compaction canceled." — is the command's
// output, never a reply, so none of it draws.

import type {
  AgentJournalItemBody,
  AgentJournalItemIdentity
} from '../../shared/agent-session-journal-types'
import { agentJournalItemKey } from '../../shared/agent-session-journal-item-key'
import { providerDiagnostic, type ProviderDiagnostic } from '../../shared/agent-session-failure'
import { agentSessionFailureWords } from '../../shared/agent-session-failure-words'
import { TUI_AGENT_DISPLAY_NAMES } from '../../shared/tui-agent-display-names'
import type { StructuredAgentSessionCommandRun } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import { structuredCompactionOutcome } from '../native-chat/agent-session-wire/structured-conversation-command-outcome'
import { claudeText } from './claude-structured-item-translation'
import { claudeResultFailure } from './claude-structured-provider-fallback'
import type { ClaudeCurrentTurn, ClaudeTurnEnd } from './claude-turn-lifecycle-item'
import { isRootClaudeFrame } from './claude-turn-opening'
import type { ClaudeOpenTurn } from './claude-open-turn'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'

export type ClaudeCommandTurn = {
  identity: AgentJournalItemIdentity
  resultIdentity: AgentJournalItemIdentity
  /** The command input's uuid, which the result answering it names. */
  sentUuid: string
  compacted: boolean
  /** Orca asked Claude to stop the command. */
  interruptRequested: boolean
  /** Claude reported the compaction failed, with its words for a person when it gave any. */
  failed: { detail?: ProviderDiagnostic } | null
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
      failed: null
    }
  }
}

/** Reads a running command's evidence off a frame. True for the command's own output, which
 *  draws nothing. */
export function observeClaudeCommandFrame(
  command: ClaudeCommandTurn | null,
  message: Record<string, unknown>
): boolean {
  if (!command) {
    return false
  }
  if (message.type === 'system') {
    // Only the boundary says the history was replaced; `compact_result: 'success'` precedes it.
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

/** The command's end from a root result, and the one row that reports it; null when the result
 *  names another input. */
export function claudeCommandEnd(
  command: ClaudeCommandTurn,
  message: Record<string, unknown>,
  completedAt: number
): { end: ClaudeTurnEnd; row: AgentJournalItemBody | null } | null {
  const answers = claudeText(message.user_message_uuid)
  if (answers !== null && answers !== command.sentUuid) {
    return null
  }
  // A stopped `/compact` ends in the same success result as a finished one: only the provider's
  // report of the compaction tells them apart.
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
  // An error result already draws its own row through the provider fallback.
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

/** A root result, when a command is the open turn: the command's end, with its one result row
 *  already written; `another-input` for a result that answers something else; null when no
 *  command is open. */
export function claudeCommandResultEnd(
  turn: Pick<ClaudeOpenTurn, 'command' | 'turnScope'>,
  sink: Pick<StructuredAgentSessionEventSink, 'appendItem'>,
  message: Record<string, unknown>,
  completedAt: number
): ClaudeTurnEnd | 'another-input' | null {
  const { command } = turn
  if (!command) {
    return null
  }
  const ended = claudeCommandEnd(command, message, completedAt)
  if (!ended) {
    return 'another-input'
  }
  if (ended.row) {
    sink.appendItem(command.resultIdentity, ended.row, { turnScope: turn.turnScope })
  }
  return ended.end
}
