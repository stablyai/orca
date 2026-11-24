import { writeDeletedChat } from './journal-deleted-chats'
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
import { absorbForgottenJournalLegacyChat } from './database/journal-legacy-compare'
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
  if (input.kind === 'record' && input.command.kind === 'workspace' && resolved.changed) {
    // The journal head names the workspace too; it moves with the record in the same transaction.
    db.prepare(
      'UPDATE journal_chat_state SET workspace_id=? WHERE session_id=? AND workspace_id=?'
    ).run(input.command.to, input.sessionId, input.command.from)
  }
  const forgotten =
    input.kind === 'command' && resolved.value === true
      ? input.command.kind === 'forget-idle'
        ? [input.command.sessionId]
        : input.command.kind === 'forget-chat'
          ? input.command.sessionIds
          : []
      : []
  for (const sessionId of forgotten) {
    markJournalChatForgotten(db, sessionId)
    absorbForgottenJournalLegacyChat(db, sessionId)
    // Its connector requests are owed an outcome still: the chat no longer has them.
    forgetJournalConnectorReplies(db, sessionId, Date.now())
  }
  if (input.kind === 'command' && input.command.kind === 'forget-chat' && resolved.value === true) {
    // In the deletion's own transaction: nothing can see the records gone without the tombstone.
    const { chatId, sessionIds, conversations } = input.command
    writeDeletedChat(db, { chatId, sessionIds: [...sessionIds], conversations: [...conversations] })
  }
  return {
    kind: 'store',
    disposition: resolved.changed ? 'applied' : 'noop',
    writes: resolved.acknowledged,
    value: resolved.value
  }
}
