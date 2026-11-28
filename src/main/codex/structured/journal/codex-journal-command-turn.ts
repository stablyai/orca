// Command-carrying provider turns share the command's journal turn instead of creating a second one.

import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentJournalTurnScope } from '../../../../shared/agent-session/journal/agent-session-journal-turn-scope'
import { agentJournalItemKey } from '../../../../shared/agent-session/journal/agent-session-journal-item-key'
import { agentJournalTurnBody } from '../../../../shared/agent-session/lifecycle/records/agent-session-turn-record'
import { providerDiagnostic } from '../../../../shared/agent-session/failures/agent-session-failure'
import { agentSessionFailureWords } from '../../../../shared/agent-session/failures/agent-session-failure-words'
import { TUI_AGENT_DISPLAY_NAMES } from '../../../../shared/agent-launch/catalog/tui-agent-display-names'
import type { JournalLifecycleIdentityMutationInput } from '../../../native-chat/agent-session-journal/writing/journal-lifecycle-mutation'
import type { StructuredAgentSessionCommandRun } from '../../../native-chat/agent-session-wire/providers/structured-agent-session-adapter'
import { structuredCompactionOutcome } from '../../../native-chat/agent-session-wire/operations/structured-conversation-command-outcome'
import { readCodexJournalRecord } from './codex-structured-journal-translation-values'
import { readCodexTurnId } from '../../app-server/codex-structured-thread-facts'
import type { StructuredAgentSessionEventSink } from '../../../native-chat/agent-session-wire/journal-ingress/structured-agent-session-event-sink'
import {
  codexTerminalRowIdentity,
  writeCodexFailureRow,
  type CodexFailureStop
} from './codex-frame-row-write'
import {
  CODEX_JOURNAL_ADMITTED,
  type CodexJournalTranslationAdmission
} from './codex-structured-journal-contracts'

/** A carried command's end: its own failure row, if any, apart from the rows that settle it. */
export type CodexCommandEnd = {
  failure: {
    row: JournalLifecycleIdentityMutationInput & { kind: 'item' }
    stop: CodexFailureStop
    /** Codex's own error row for the turn, which this one repeats where it shows. */
    unlessItemId?: string
  } | null
  mutations: JournalLifecycleIdentityMutationInput[]
}

/** A command's failure row, decided by the writer like Codex's own error rows, ahead of the batch
 *  that settles the command; a sink that can't decide at its writer gets it in that batch. */
export function writeCodexCommandFailure(
  sink: StructuredAgentSessionEventSink,
  end: CodexCommandEnd
): {
  admission: CodexJournalTranslationAdmission
  mutations: JournalLifecycleIdentityMutationInput[]
} {
  if (!end.failure) {
    return { admission: CODEX_JOURNAL_ADMITTED, mutations: end.mutations }
  }
  const { row, stop, unlessItemId } = end.failure
  if (!sink.tryReviseResolvedItem) {
    // As before: Codex's own error frame stands for the command's failure.
    const rows = unlessItemId ? [] : [row]
    return { admission: CODEX_JOURNAL_ADMITTED, mutations: [...rows, ...end.mutations] }
  }
  return {
    admission: writeCodexFailureRow(
      sink,
      row.identity,
      row.body,
      { turnScope: row.turnScope },
      stop,
      unlessItemId
    ),
    mutations: end.mutations
  }
}

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

  /** The journal turn a provider turn's rows belong to: the command's own when it carries one. */
  journalTurnId(providerTurnId: string): string {
    return this.carried.get(providerTurnId)?.command.turnId ?? providerTurnId
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
      threadId: string
      status: string | null
      error: string | null
      completedAt: number
    }
  ): CodexCommandEnd {
    const carried = this.carried.get(providerTurnId)
    if (!carried) {
      return { failure: null, mutations: [] }
    }
    const { command } = carried
    const detail = ended.error === null ? undefined : providerDiagnostic(ended.error, 'person')
    const verdict = structuredCompactionOutcome({
      compacted: carried.compacted,
      interruptRequested: ended.status === 'interrupted',
      failed: ended.status !== 'completed' || detail ? (detail ? { detail } : {}) : null
    })
    const turnScope = { kind: 'turn' as const, turnItemId: agentJournalItemKey(command.identity) }
    // Successful compaction already has Codex's marker; do not add a second status row. After
    // Codex's own error frame, the writer adds this row only where a Stop dropped that frame's row.
    const failure = verdict.failure
      ? {
          row: {
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
          },
          stop: { turnId: command.turnId, endedAt: ended.completedAt },
          ...(carried.failureShown
            ? {
                unlessItemId: agentJournalItemKey(
                  codexTerminalRowIdentity(ended.threadId, providerTurnId)
                )
              }
            : {})
        }
      : null
    const mutations: JournalLifecycleIdentityMutationInput[] = [
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
    return { failure, mutations }
  }

  // Codex's own terminal error frame was admitted: the command's row only repeats it.
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
