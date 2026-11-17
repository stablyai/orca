import type { AgentJournalOrcaCardItem } from '../../../../shared/agent-journal-orca-card-items'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalPlainStatusItem
} from '../../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentJournalTurnScope } from '../../../../shared/agent-session/journal/agent-session-journal-turn-scope'
import { readHostStructuredAgentSessionWork } from '../observations/structured-agent-session-read-work'
import { restoreJournalSqlFailure } from '../../agent-session-journal/journal-sql-failure'
import { estimateStructuredAgentSessionItemBytes } from '../journal-ingress/structured-agent-session-event-sink-estimate'
import type {
  StructuredAgentSessionHostDeps,
  StructuredAgentSessionHostSession
} from '../host/structured-agent-session-host-types'

/** A status line Orca writes into a chat, named so a retry writes it once. */
export type OrcaStatusLine = { body: AgentJournalPlainStatusItem; messageId: string }

// One card per started worker or agent launch, per saved version of an automation, and per added tool.
function orcaCardMessageId(entry: AgentJournalOrcaCardItem | OrcaStatusLine): string {
  if ('messageId' in entry) {
    return entry.messageId
  }
  switch (entry.kind) {
    case 'agent-start':
      return `agent-start:${entry.dispatchId}`
    case 'agent-handoff':
      return `agent-handoff:${entry.launchId}`
    case 'automation-saved':
      return `automation-saved:${entry.automation.id}:${entry.automation.updatedAt}`
    case 'tool-added':
      return `tool-added:${entry.botId}:${entry.tool.name}:${entry.addedAt}`
    case 'wait-ended':
      return `wait-ended:${entry.automation.id}`
    case 'automation-run-not-started':
      return `automation-run-not-started:${entry.run.runId}`
    case 'bot-item-note':
      return `bot-item-note:${entry.noteId}`
  }
}

function isBotOwnItemNote(entry: AgentJournalOrcaCardItem | OrcaStatusLine): boolean {
  return !('messageId' in entry) && entry.kind === 'bot-item-note' && entry.by === 'bot'
}

export type AgentStartDestination = { sessionId: string; epoch: string; contextId: string | null }

export function structuredAgentStartJournal(
  deps: () => StructuredAgentSessionHostDeps,
  conversation: (sessionId: string) => Promise<StructuredAgentSessionHostSession>
) {
  /** Record only in this transcript; opening at rest neither follows clears nor starts its agent. */
  const captureAgentStartDestination = (
    sessionId: string
  ): Promise<AgentStartDestination | null> | null => {
    const record = deps().store.getConversation(sessionId)
    if (!record) {
      return null
    }
    const contextId = record.providerContextBoundary?.operationId ?? null
    return deps()
      .journalDatabase.sessionEpoch(sessionId)
      .then((epoch) => {
        const current = deps().store.getConversation(sessionId)
        return epoch &&
          current &&
          (current.providerContextBoundary?.operationId ?? null) === contextId
          ? { sessionId, epoch, contextId }
          : null
      })
  }

  const runningTurnScope = async (sessionId: string): Promise<AgentJournalTurnScope> => {
    const session = await conversation(sessionId)
    const { activeTurn } = await readHostStructuredAgentSessionWork(
      { store: deps().store, sessions: { get: (id) => (id === sessionId ? session : undefined) } },
      sessionId,
      { kind: 'turn' }
    )
    return activeTurn
      ? { kind: 'turn', turnItemId: activeTurn.item.itemId }
      : AGENT_JOURNAL_THREAD_SCOPE
  }

  const appendAgentStart = async (
    destination: AgentStartDestination,
    entry: AgentJournalOrcaCardItem | OrcaStatusLine,
    observedAt: number
  ): Promise<void> => {
    const { sessionId } = destination
    const stillSameContext = () => {
      const current = deps().store.getConversation(sessionId)
      return (
        current !== null &&
        (current.providerContextBoundary?.operationId ?? null) === destination.contextId
      )
    }
    if (!stillSameContext()) {
      return
    }
    const { journal } = await conversation(sessionId)
    const identity = {
      provider: 'orca' as const,
      clientMessageId: orcaCardMessageId(entry)
    }
    const body = 'messageId' in entry ? entry.body : entry
    // The bot's own item write joins the turn running it, so its adds in one turn draw as one row.
    const turnScope: AgentJournalTurnScope = isBotOwnItemNote(entry)
      ? await runningTurnScope(sessionId)
      : AGENT_JOURNAL_THREAD_SCOPE
    const result = await journal.appendSteps(
      [
        {
          kind: 'creation-fact',
          epoch: destination.epoch,
          identity,
          body,
          reservedBytes: estimateStructuredAgentSessionItemBytes(identity, body),
          options: {
            fence: deps().store.getConversation(sessionId)?.currentFence ?? 0,
            turnScope,
            observedAt
          }
        }
      ],
      stillSameContext
    )
    if (result.failure) {
      throw restoreJournalSqlFailure(result.failure)
    }
  }

  const nativeAutomationReceipt = async (sessionId: string, itemId: string) => {
    const { journal } = await conversation(sessionId)
    const item = await journal.reads.nativeAutomationReceipt(itemId)
    return item?.body.kind === 'automation-saved' ? item.body : null
  }

  return { captureAgentStartDestination, appendAgentStart, nativeAutomationReceipt }
}
