import type Database from '../../sqlite/sync-database'
import { agentJournalItemKey } from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import type { JournalWriterCommand } from './journal-writer-command'
import type { JournalWriterPublication } from './journal-writer-changes'
import { claimAgentSessionAttachmentsInTransaction } from '../agent-session-attachments/agent-session-attachment-claims'
import { JournalGoalAttachmentInverse } from './writing/journal-goal-attachment-inverse'

/** Durable claims commit with input writes; the live inverse is adopted only after acknowledgement. */
export function claimJournalSqlItemInputs(
  db: Database.Database,
  stateDirectory: string,
  command: JournalWriterCommand,
  publication: JournalWriterPublication
) {
  const { operation, target } = command
  const userItems = publication.items.filter(
    (item) => item.body.kind === 'message' && item.body.role === 'user'
  )
  const goals = new JournalGoalAttachmentInverse(target.sessionId)
  if (command.facts?.goals) {
    goals.adopt(command.facts.goals)
  }
  const referencedUploads = [...(publication.referencedUploads ?? [])]
  if (operation.kind !== 'item-claiming') {
    goals.acquired(new Set(referencedUploads), [])
  }
  if (operation.kind === 'item-claiming') {
    const itemId = agentJournalItemKey(operation.identity)
    const claim = claimAgentSessionAttachmentsInTransaction(db, {
      stateDirectory,
      sessionId: target.sessionId,
      body: operation.body,
      required: true,
      now: command.savedAt ?? Date.now()
    })
    goals.acquired(
      claim.referenced,
      claim.inserted,
      operation.body.sentAs === 'goal' ? itemId : undefined
    )
    referencedUploads.push(...claim.referenced)
  } else if (
    operation.kind === 'item' ||
    operation.kind === 'lifecycle' ||
    operation.kind === 'steps' ||
    operation.kind === 'prompt-mutate'
  ) {
    for (const item of userItems) {
      if (item.body.kind !== 'message' || item.body.role !== 'user' || goals.isLive(item.itemId)) {
        continue
      }
      const claim = claimAgentSessionAttachmentsInTransaction(db, {
        stateDirectory,
        sessionId: target.sessionId,
        body: item.body,
        required: false,
        now: command.savedAt ?? Date.now()
      })
      goals.acquired(claim.referenced, claim.inserted)
      referencedUploads.push(...claim.referenced)
    }
  }
  return {
    referencedUploads,
    ...(operation.kind === 'item-claiming' || command.facts?.goals
      ? { goals: goals.snapshot() }
      : {})
  }
}
