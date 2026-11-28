import Database from '../sqlite/sync-database'
import { migrateJournalDomainSchema } from '../native-chat/agent-session-journal/journal-domain-schema'
import { ensureAgentSessionAttachmentClaimTables } from '../native-chat/agent-session-attachments/agent-session-attachment-claims'
import { applyJournalDomainSubmission } from '../native-chat/agent-session-journal/journal-domain-submission-admission'
import { applyJournalDomainDispatch } from '../native-chat/agent-session-journal/journal-domain-dispatch'
import { applyJournalDomainItem } from '../native-chat/agent-session-journal/journal-domain-item'
import { readJournalDomainTurnAttribution } from '../native-chat/agent-session-journal/journal-domain-turn-attribution'
import { readJournalDomainOperationWindow } from '../native-chat/agent-session-journal/journal-domain-operation-window'
import { JournalSqlScope } from '../native-chat/agent-session-journal/journal-sql-scope'
import { codexTurnLifecycleIdentity } from '../codex/structured/journal/codex-structured-journal-translation-turns'
import { codexProviderHandle } from '../../shared/agent-session/lifecycle/provider-handles/agent-session-provider-handle-encoding'
import { agentSessionSendBodyFingerprint } from '../../shared/agent-session/requests/structured-agent-session-send-mutation'
import {
  agentJournalItemKey,
  agentJournalSubmissionKey
} from '../../shared/agent-session/journal/agent-session-journal-item-key'
import type {
  AgentJournalMessageItem,
  AgentJournalItemBody
} from '../../shared/agent-session/journal/agent-session-journal-types'

/** Provider-accepted deliveries and text in an isolated, real journal, without running an agent. */
export function remoteGroupJournal(directory: string, sessionId: string) {
  const db = new Database(':memory:')
  migrateJournalDomainSchema(db)
  ensureAgentSessionAttachmentClaimTables(db)
  db.prepare(`INSERT INTO journal_chat_state(session_id,workspace_id,epoch,last_sequence,highest_fence)
    VALUES(?, 'workspace', 'epoch', 0, 1)`).run(sessionId)
  const target = { sessionId, epoch: 'epoch' }
  const scope = () => new JournalSqlScope(db, sessionId, 'epoch')
  let now = 1_800_000_000_000
  let ordinal = 0
  const item = (turnId: string, body: AgentJournalItemBody, root = false) => {
    applyJournalDomainItem(
      db,
      target,
      {
        kind: 'item',
        identity: root
          ? codexTurnLifecycleIdentity(sessionId, turnId)
          : { provider: 'codex', threadId: sessionId, turnId, ordinal: ordinal++ },
        body,
        options: {
          turnScope: root
            ? { kind: 'thread' }
            : {
                kind: 'turn',
                turnItemId: agentJournalItemKey(codexTurnLifecycleIdentity(sessionId, turnId))
              },
          fence: 1
        }
      },
      now++
    )
  }
  const send = (operationId: string, body: AgentJournalMessageItem, turnId: string) => {
    applyJournalDomainSubmission(
      db,
      directory,
      target,
      {
        kind: 'submission',
        input: {
          clientMessageId: operationId,
          body,
          payloadFingerprint: agentSessionSendBodyFingerprint(sessionId, body),
          fence: 1,
          origin: 'client',
          source: { kind: 'agent' },
          handoverRecorded: true
        }
      },
      {
        identity: {
          sessionId,
          workspaceId: 'workspace',
          hostId: 'host',
          agent: 'codex',
          providerHandle: codexProviderHandle(sessionId)
        }
      },
      now++
    )
    applyJournalDomainDispatch(
      db,
      target,
      {
        kind: 'dispatch',
        input: {
          clientMessageId: operationId,
          fence: 1,
          state: 'pending',
          turnScope: { kind: 'thread' }
        }
      },
      now++
    )
    applyJournalDomainDispatch(
      db,
      target,
      {
        kind: 'dispatch',
        input: {
          clientMessageId: operationId,
          fence: 1,
          state: 'accepted',
          providerIdentity: { provider: 'codex', threadId: sessionId, turnId, ordinal: ordinal++ },
          answeredInTurn: { turn: codexTurnLifecycleIdentity(sessionId, turnId), via: 'start' }
        }
      },
      now++
    )
    item(
      turnId,
      {
        kind: 'turn',
        turnId,
        state: 'running',
        userItemId: agentJournalSubmissionKey(operationId)
      },
      true
    )
  }
  const finish = (
    operationId: string,
    turnId: string,
    text: string,
    outcome: 'success' | 'failure' = 'success'
  ) => {
    if (text) {
      item(turnId, {
        kind: 'message',
        role: 'assistant',
        blocks: [{ type: 'text', text }]
      })
    }
    item(
      turnId,
      {
        kind: 'turn',
        turnId,
        state: 'completed',
        outcome,
        userItemId: agentJournalSubmissionKey(operationId)
      },
      true
    )
  }
  const write = (run: () => void) => {
    db.exec('BEGIN IMMEDIATE')
    try {
      run()
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }
  return {
    send: (...args: Parameters<typeof send>) => write(() => send(...args)),
    finish: (...args: Parameters<typeof finish>) => write(() => finish(...args)),
    reads: {
      turnAttribution: async (turnId: string, through: number) =>
        readJournalDomainTurnAttribution(scope(), turnId, through),
      operationWindow: async (anchors: Parameters<typeof readJournalDomainOperationWindow>[1]) =>
        readJournalDomainOperationWindow(scope(), anchors)
    },
    words: () =>
      readJournalDomainOperationWindow(scope(), { afterSequence: 0 }).snapshot.items.flatMap(
        (row) =>
          row.body.kind === 'message'
            ? row.body.blocks.flatMap((block) => (block.type === 'text' ? block.text : []))
            : []
      ),
    close: () => db.close()
  }
}
