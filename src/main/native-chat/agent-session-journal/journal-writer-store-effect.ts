import type Database from '../../sqlite/sync-database'
import { writeAgentSessionStoreRows } from '../../runtime/agent-session/records/agent-session-record-rows'
import type {
  JournalWriterEffect,
  JournalWriterStoreResult,
  JournalWriterCoordinate
} from './journal-writer-effects'
import type { JournalRow } from './durable-rows/journal-row-schema'
import { resolveJournalWriterStoreMutation } from './journal-writer-store-mutation'
import { commitAgentSessionPublicationFence } from '../../runtime/agent-session/agent-session-publication-fence'
import { markJournalChatForgotten } from './journal-forgotten-chats'
import { forgetJournalConnectorReplies } from './connector-replies/journal-connector-replies'

export function applyJournalWriterStoreEffect(
  db: Database.Database,
  effect: Extract<JournalWriterEffect, { kind: 'store' }>,
  rows: readonly (JournalRow | JournalWriterCoordinate)[] = []
): JournalWriterStoreResult {
  const resolved = resolveJournalWriterStoreMutation(
    db,
    effect.mutation.input,
    effect.mutation.at,
    rows
      .flatMap((row) =>
        'planApprovalMode' in row && row.planApprovalMode ? [row.planApprovalMode] : []
      )
      .at(-1),
    effect.mutation.runtime
  )
  const input = effect.mutation.input
  if (input.kind === 'command' && input.command.kind === 'tab-visibility') {
    commitAgentSessionPublicationFence(input.command.writerFence)
  }
  writeAgentSessionStoreRows(db, resolved.writes)
  if (input.kind === 'command' && input.command.kind === 'forget-idle' && resolved.value === true) {
    markJournalChatForgotten(db, input.command.sessionId)
    // Its connector requests are owed an outcome still: the chat no longer has them.
    forgetJournalConnectorReplies(db, input.command.sessionId, Date.now())
  }
  return {
    kind: 'store',
    disposition: resolved.changed ? 'applied' : 'noop',
    writes: resolved.acknowledged,
    value: resolved.value
  }
}
