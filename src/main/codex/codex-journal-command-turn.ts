// Command-carrying provider turns share the command's journal turn instead of creating a second one.

import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalTurnScope
} from '../../shared/agent-session-journal-types'
import { agentJournalItemKey } from '../../shared/agent-session-journal-item-key'
import { agentJournalTurnBody } from '../../shared/agent-session-turn-record'
import { providerDiagnostic } from '../../shared/agent-session-failure'
import { agentSessionFailureWords } from '../../shared/agent-session-failure-words'
import { TUI_AGENT_DISPLAY_NAMES } from '../../shared/tui-agent-display-names'
import type { JournalLifecycleIdentityMutationInput } from '../native-chat/agent-session-journal/journal-row-builders'
import type { StructuredAgentSessionCommandRun } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import { structuredCompactionOutcome } from '../native-chat/agent-session-wire/structured-conversation-command-outcome'
import { readCodexJournalRecord } from './codex-structured-journal-translation-values'
import { readCodexTurnId } from './codex-structured-thread-facts'

type CarriedCommand = {
  command: StructuredAgentSessionCommandRun
  compacted: boolean
  failureShown: boolean
}

export class CodexJournalCommandTurn {
  // Sent but not yet claimed by a provider turn.
  private awaiting: StructuredAgentSessionCommandRun | null = null
  private readonly carried = new Map<string, CarriedCommand>()

  begin(command: StructuredAgentSessionCommandRun): void {
    this.awaiting = command
  }

  forget(turnId: string): void {
    if (this.awaiting?.turnId === turnId) {
      this.awaiting = null
    }
  }

  // Repeated claims must return the same command when a refused frame is retried.
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

  /** An unclaimed command has no provider turn to interrupt. */
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

  compacted(providerTurnId: string): void {
    const carried = this.carried.get(providerTurnId)
    if (carried) {
      carried.compacted = true
    }
  }

  end(
    providerTurnId: string,
    ended: {
      status: string | null
      error: string | null
      completedAt: number
    }
  ): JournalLifecycleIdentityMutationInput[] {
    const carried = this.carried.get(providerTurnId)
    if (!carried) {
      return []
    }
    const { command } = carried
    const detail = ended.error === null ? undefined : providerDiagnostic(ended.error, 'person')
    const verdict = structuredCompactionOutcome({
      compacted: carried.compacted,
      interruptRequested: ended.status === 'interrupted',
      failed: ended.status !== 'completed' || detail ? (detail ? { detail } : {}) : null
    })
    const turnScope = { kind: 'turn' as const, turnItemId: agentJournalItemKey(command.identity) }
    return [
      // Successful compaction already has Codex's marker; do not add a second status row.
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

  // Suppress duplicate failure rows after Codex's own terminal error frame.
  errorShown(params: unknown): void {
    const providerTurnId = readCodexTurnId(params)
    const carried = providerTurnId ? this.carried.get(providerTurnId) : undefined
    // Retried stream errors do not end the command.
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
