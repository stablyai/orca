import type { AgentJournalSnapshot } from '../../../shared/agent-session/journal/agent-session-journal-types'
import {
  agentSessionCurrentContextRows,
  latestAgentSessionContextClearSequence
} from '../../../shared/agent-session/agent-session-context-clear'
import { agentJournalSubmissionKey } from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import { projectSavedChatContextItems } from '../agent-session-saved-prompt-text'
import { formatWorkerTranscriptMessage } from '../../../shared/worker-transcript-text'
import type { ContextTransferCapture, ContextTransferMessage } from './context-transfer-record'
import { contextTransferDigest, recoveryPriority } from '../agent-session-context-transfer-text'

export function captureRecoveryContext(
  snapshot: AgentJournalSnapshot,
  canonical: (id: string) => string
): {
  capture: ContextTransferCapture
  contextFloor: AgentJournalSnapshot['cursor'] | null
  text: string
} {
  const excluded = new Set(
    snapshot.submissions.flatMap((row) =>
      row.dispatchState === 'accepted'
        ? []
        : [
            canonical(agentJournalSubmissionKey(row.clientMessageId)),
            ...(row.providerItemId ? [canonical(row.providerItemId)] : [])
          ]
    )
  )
  const current = agentSessionCurrentContextRows(snapshot.items, snapshot.submissions)
  const seen = new Set<string>()
  const messages: ContextTransferMessage[] = []
  for (const item of current.items) {
    const key = canonical(item.itemId)
    if (seen.has(key) || excluded.has(key)) {
      continue
    }
    seen.add(key)
    if (
      (item.body.kind === 'question' || item.body.kind === 'approval') &&
      item.body.resolution.state !== 'resolved'
    ) {
      continue
    }
    const projected = projectSavedChatContextItems([item])
    for (const [index, message] of projected.entries()) {
      const text = formatWorkerTranscriptMessage(message)
      if (!text.trim()) {
        continue
      }
      messages.push({
        itemId: key,
        revision: item.revision,
        sequence: item.sequence,
        sequenceIndex: item.sequenceIndex ?? index,
        role: message.role === 'user' ? 'user' : 'assistant',
        kind: item.body.kind,
        text
      })
    }
  }
  const coverage = {
    eligibleCount: messages.length,
    omittedCount: 0,
    firstItemId: messages[0]?.itemId ?? null,
    lastItemId: messages.at(-1)?.itemId ?? null,
    inventoryDigest: contextTransferDigest(messages)
  }
  const captured: ContextTransferCapture = { selectionVersion: 1, messages: [], coverage }
  const selected = new Set<number>()
  let capturedBytes = Buffer.byteLength(JSON.stringify(captured)) + 32
  for (const index of recoveryPriority(messages)) {
    if (selected.has(index) || index < 0) {
      continue
    }
    const bytes = Buffer.byteLength(JSON.stringify(messages[index])) + 1
    if (capturedBytes + bytes <= 64_000) {
      selected.add(index)
      capturedBytes += bytes
    }
  }
  captured.messages = messages.filter((_, index) => selected.has(index))
  captured.coverage.omittedCount = messages.length - captured.messages.length
  const floor = latestAgentSessionContextClearSequence(snapshot.items)
  return {
    capture: captured,
    contextFloor: floor ? { epoch: snapshot.cursor.epoch, sequence: floor } : null,
    text: messages.map((message) => message.text).join('\n\n')
  }
}
