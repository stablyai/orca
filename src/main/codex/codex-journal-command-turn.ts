// The conversation command a Codex child is running. Codex carries a command out as a turn of its
// own; that turn writes no record, its rows join the command's turn, and its end is the command's.
// Held by the child's translator, so it ends with the child and nothing has to release it.

import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalTurnScope
} from '../../shared/agent-session-journal-types'
import { agentJournalItemKey } from '../../shared/agent-session-journal-item-key'
import { agentJournalTurnBody } from '../../shared/agent-session-turn-record'
import { providerDiagnostic } from '../../shared/agent-session-failure'
import { agentSessionFailureWords } from '../../shared/agent-session-failure-words'
import { TUI_AGENT_DISPLAY_NAMES } from '../../shared/tui-agent-display-names'
import type { JournalLifecycleMutationInput } from '../native-chat/agent-session-journal/journal-row-builders'
import type { StructuredAgentSessionCommandRun } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import { structuredCompactionOutcome } from '../native-chat/agent-session-wire/structured-conversation-command-outcome'
import { readCodexJournalRecord } from './codex-structured-journal-translation-values'
import { readCodexTurnId } from './codex-structured-thread-facts'

type CarriedCommand = {
  command: StructuredAgentSessionCommandRun
  compacted: boolean
  /** Codex's own error row already says why the command failed. */
  failureShown: boolean
}

export class CodexJournalCommandTurn {
  /** Sent, and not yet carried by a provider turn. */
  private awaiting: StructuredAgentSessionCommandRun | null = null
  private readonly carried = new Map<string, CarriedCommand>()

  /** Before Orca sends the command: the next primary turn to start carries it out. */
  begin(command: StructuredAgentSessionCommandRun): void {
    this.awaiting = command
  }

  /** The command was never taken. */
  forget(turnId: string): void {
    if (this.awaiting?.turnId === turnId) {
      this.awaiting = null
    }
  }

  /** The command the primary turn `providerTurnId` carries out. Idempotent per provider turn, so a
   *  refused frame's retry gets the same answer. */
  claim(providerTurnId: string): StructuredAgentSessionCommandRun | null {
    const carried = this.carried.get(providerTurnId)
    if (carried || !this.awaiting) {
      return carried?.command ?? null
    }
    const command = this.awaiting
    this.awaiting = null
    this.carried.set(providerTurnId, { command, compacted: false, failureShown: false })
    return command
  }

  isCarrying(providerTurnId: string): boolean {
    return this.carried.has(providerTurnId)
  }

  scopeFor(providerTurnId: string): AgentJournalTurnScope | null {
    const carried = this.carried.get(providerTurnId)
    return carried
      ? { kind: 'turn', turnItemId: agentJournalItemKey(carried.command.identity) }
      : null
  }

  /** The provider turn a Stop on `turnId` interrupts: none while the command has not started one. */
  providerTurnId(turnId: string): string | undefined {
    if (this.awaiting?.turnId === turnId) {
      return undefined
    }
    for (const [providerTurnId, { command }] of this.carried) {
      if (command.turnId === turnId) {
        return providerTurnId
      }
    }
    return turnId
  }

  /** Codex reported the compaction, in the turn carrying the command. */
  compacted(providerTurnId: string): void {
    const carried = this.carried.get(providerTurnId)
    if (carried) {
      carried.compacted = true
    }
  }

  /** The command's end, for the batch that settles the provider turn carrying it. */
  end(
    providerTurnId: string,
    ended: {
      status: string | null
      error: string | null
      completedAt: number
    }
  ): JournalLifecycleMutationInput[] {
    const carried = this.carried.get(providerTurnId)
    if (!carried) {
      return []
    }
    const { command } = carried
    const detail = ended.error === null ? undefined : providerDiagnostic(ended.error, 'person')
    const verdict = structuredCompactionOutcome({
      compacted: carried.compacted,
      // Codex reports the user's stop as the turn's own status.
      interruptRequested: ended.status === 'interrupted',
      // A turn that did not complete failed, not merely went unconfirmed.
      failed: ended.status !== 'completed' || detail ? (detail ? { detail } : {}) : null
    })
    const turnScope = { kind: 'turn' as const, turnItemId: agentJournalItemKey(command.identity) }
    return [
      // A success already drew Codex's own compaction marker inside the command's turn.
      ...(verdict.failure && !carried.failureShown
        ? [
            {
              kind: 'item' as const,
              identity: command.resultIdentity,
              body: {
                kind: 'status' as const,
                ...agentSessionFailureWords(verdict.failure, {
                  surface: 'row',
                  agentName: TUI_AGENT_DISPLAY_NAMES.codex
                }),
                tone: 'error' as const
              },
              turnScope
            }
          ]
        : []),
      {
        kind: 'item',
        identity: command.identity,
        body: agentJournalTurnBody({
          ...command.running,
          providerTurnId,
          state: verdict.outcome === 'cancellation' ? 'interrupted' : 'completed',
          outcome: verdict.outcome,
          completedAt: ended.completedAt
        }),
        turnScope: AGENT_JOURNAL_THREAD_SCOPE
      }
    ]
  }

  /** Codex's `error` frame, already a row in the turn it names. A turn-ending one says why the
   *  command failed, so the failed completion that follows it adds no second row. */
  errorShown(params: unknown): void {
    const providerTurnId = readCodexTurnId(params)
    const carried = providerTurnId ? this.carried.get(providerTurnId) : undefined
    // A stream error Codex is about to retry ends nothing.
    if (carried && readCodexJournalRecord(params).willRetry !== true) {
      carried.failureShown = true
    }
  }

  settled(providerTurnId: string): void {
    this.carried.delete(providerTurnId)
  }

  clear(): void {
    this.awaiting = null
    this.carried.clear()
  }
}
