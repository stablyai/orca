import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import Database from '../../sqlite/sync-database'
import { migrateJournalDomainSchema } from './journal-domain-schema'
import { ensureAgentSessionAttachmentClaimTables } from '../agent-session-attachments/agent-session-attachment-claims'
import { applyJournalDomainSubmission } from './journal-domain-submission-admission'
import { applyJournalDomainDispatch } from './journal-domain-dispatch'
import { applyJournalDomainItem } from './journal-domain-item'
import { readJournalDomainOperationWindow } from './journal-domain-operation-window'
import { JournalSqlScope } from './journal-sql-scope'
import { codexTurnLifecycleIdentity } from '../../codex/structured/journal/codex-structured-journal-translation-turns'
import { codexProviderHandle } from '../../../shared/agent-session/lifecycle/provider-handles/agent-session-provider-handle-encoding'
import { agentSessionSendBodyFingerprint } from '../../../shared/agent-session/requests/structured-agent-session-send-mutation'
import { agentJournalSubmissionKey } from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import type { AgentJournalMessageItem } from '../../../shared/agent-session/journal/agent-session-journal-types'

// #47529: opening one ended turn of a bot group room reads it through the operation window. Guards
// the bounded read: the rows and sends it examines stay fixed however many turns the chat ran after
// it, and each send read is pinned to its index (a full walk of the chat's sends fails to plan).
// Reverting the bound makes the count grow with those turns.

const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

const target = { sessionId: 'chat', epoch: 'epoch' }
const facts = {
  identity: {
    sessionId: 'chat',
    workspaceId: 'workspace',
    hostId: 'host',
    agent: 'codex' as const,
    providerHandle: codexProviderHandle('thread')
  }
}

/** A chat of `turns` finished turns, each opened by its own send. */
function chat(turns: number): Database {
  const directory = mkdtempSync(join(tmpdir(), 'orca-operation-window-'))
  directories.push(directory)
  const db = new Database(join(directory, 'journal.sqlite'))
  migrateJournalDomainSchema(db)
  ensureAgentSessionAttachmentClaimTables(db)
  db.prepare(`INSERT INTO journal_chat_state(session_id,workspace_id,epoch,last_sequence,highest_fence)
    VALUES('chat','workspace','epoch',0,1)`).run()
  let now = 1_800_000_000_000
  const transaction = (run: () => void) => {
    db.exec('BEGIN IMMEDIATE')
    run()
    db.exec('COMMIT')
  }
  for (let index = 0; index < turns; index += 1) {
    const id = `m${index}`
    const turn = codexTurnLifecycleIdentity('chat', `turn-${index}`)
    const body: AgentJournalMessageItem = {
      kind: 'message',
      role: 'user',
      blocks: [{ type: 'text', text: `ask ${index}` }]
    }
    transaction(() =>
      applyJournalDomainSubmission(
        db,
        directory,
        target,
        {
          kind: 'submission',
          input: {
            clientMessageId: id,
            body,
            payloadFingerprint: agentSessionSendBodyFingerprint('chat', body),
            fence: 1,
            origin: 'client',
            source: { kind: 'user' },
            handoverRecorded: true,
            // Each send carried a queued card, as agent mail to a member chat does.
            queuedMessageId: `card-${index}`
          }
        },
        facts,
        now++
      )
    )
    transaction(() =>
      applyJournalDomainDispatch(
        db,
        target,
        {
          kind: 'dispatch',
          input: {
            clientMessageId: id,
            fence: 1,
            state: 'accepted',
            providerIdentity: {
              provider: 'codex',
              threadId: 'thread',
              turnId: 'echo',
              ordinal: index
            },
            answeredInTurn: { turn, via: 'start' }
          }
        },
        now++
      )
    )
    transaction(() =>
      applyJournalDomainItem(
        db,
        target,
        {
          kind: 'item',
          identity: turn,
          body: {
            kind: 'turn',
            turnId: `turn-${index}`,
            state: 'completed',
            outcome: 'success',
            userItemId: agentJournalSubmissionKey(id)
          },
          options: { turnScope: { kind: 'thread' }, fence: 1 }
        },
        now++
      )
    )
  }
  return db
}

function openFirstTurn(turns: number, operationId = 'm0') {
  const db = chat(turns)
  const scope = new JournalSqlScope(db, 'chat', 'epoch')
  const { snapshot } = readJournalDomainOperationWindow(scope, {
    operationIds: [operationId],
    anchorsOnly: true,
    throughAnchoredTurns: true
  })
  // The whole-chat read of the same operation, for the rows of its own turn.
  const whole = readJournalDomainOperationWindow(new JournalSqlScope(db, 'chat', 'epoch'), {
    operationIds: [operationId]
  }).snapshot
  db.close()
  return { snapshot, whole, examined: scope.work.rows }
}

const turnZero = (items: readonly { itemId: string; sequence: number }[], end: number) =>
  items.filter((item) => item.sequence < end).map((item) => item.itemId)

it('opens one old turn with the same work however many turns followed it', () => {
  for (const turns of [10, 100]) {
    for (const operationId of ['m0', 'card-0']) {
      const { snapshot, whole, examined } = openFirstTurn(turns, operationId)
      expect(examined).toBe(12)
      // Its own send, and the next turn's, whose prompt sits just before where that turn opens.
      expect(snapshot.submissions.map((send) => send.clientMessageId)).toEqual(['m0', 'm1'])
      const turnIds = snapshot.items.flatMap((item) =>
        item.body.kind === 'turn' ? [item.body.turnId] : []
      )
      expect(turnIds).toEqual(['turn-0'])
      // The same rows the whole-chat read holds up to where the next turn opens.
      const end = Math.max(...snapshot.items.map((item) => item.sequence)) + 1
      expect(turnZero(snapshot.items, end)).toEqual(turnZero(whole.items, end))
    }
  }
})
