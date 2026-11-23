// A journal on disk with admitted sends to recover, shared by the input-recovery tests.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from '../../sqlite/sync-database'
import type { AgentJournalMessageItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import { codexProviderHandle } from '../../../shared/agent-session/lifecycle/provider-handles/agent-session-provider-handle-encoding'
import { agentSessionSendBodyFingerprint } from '../../../shared/agent-session/requests/structured-agent-session-send-mutation'
import { agentSessionFailureWords } from '../../../shared/agent-session/failures/agent-session-failure-words'
import { migrateJournalDomainSchema } from './journal-domain-schema'
import { applyJournalDomainSubmission } from './journal-domain-submission-admission'
import { applyJournalDomainDispatch } from './journal-domain-dispatch'
import {
  applyJournalDomainInputRecovery,
  type JournalDomainInputRecoveryOperation
} from './journal-domain-input-recovery'
import {
  applyJournalDomainCommandTurn,
  type JournalDomainCommandTurnOperation
} from './journal-domain-command-turn'
import {
  readJournalDomainSubmissionAttempt,
  type JournalDomainSubmissionFacts
} from './journal-domain-submission-records'
import { readJournalDomainDispatchItem } from './journal-domain-dispatch-placement'
import { insertJournalDomainQueueRow, journalDomainQueueRow } from './journal-domain-queue-rows'
import { ensureAgentSessionAttachmentClaimTables } from '../agent-session-attachments/agent-session-attachment-claims'
import type { JournalWriterOperation } from './journal-writer-command'
import type { ResolveDispatchInput } from './journal-store-contracts'

export const target = { sessionId: 'chat', epoch: 'epoch' }
export const now = 1_800_000_000_000
const cleanups: (() => void)[] = []
type Submission = Extract<JournalWriterOperation, { kind: 'submission' }>
export const message = (text: string): AgentJournalMessageItem => ({
  kind: 'message',
  role: 'user',
  blocks: [{ type: 'text', text }]
})
export const failure = agentSessionFailureWords({ kind: 'notSignedIn' }, { surface: 'rejection' })

export function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'orca-domain-input-recovery-'))
  const filename = join(directory, 'journal.sqlite')
  let db = new Database(filename)
  migrateJournalDomainSchema(db)
  ensureAgentSessionAttachmentClaimTables(db)
  db.prepare(`INSERT INTO journal_chat_state(session_id,workspace_id,epoch,last_sequence,highest_fence)
    VALUES('chat','workspace','epoch',10,1)`).run()
  cleanups.push(() => {
    db.close()
    rmSync(directory, { recursive: true, force: true })
  })
  const facts: JournalDomainSubmissionFacts = {
    identity: {
      sessionId: 'chat',
      workspaceId: 'workspace',
      hostId: 'host',
      agent: 'codex',
      providerHandle: codexProviderHandle('thread')
    }
  }
  const transaction = <T>(run: () => T): T => {
    db.exec('BEGIN IMMEDIATE')
    try {
      const value = run()
      db.exec('COMMIT')
      return value
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }
  const admit = (
    id: string,
    fields: Partial<Submission['input']> = {},
    consume?: Submission['consume']
  ) => {
    const body = fields.body ?? message(id)
    return transaction(() =>
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
            ...fields
          },
          ...(consume ? { consume } : {})
        },
        facts,
        now
      )
    )
  }
  const dispatch = (input: ResolveDispatchInput) =>
    transaction(() => applyJournalDomainDispatch(db, target, { kind: 'dispatch', input }, now + 10))
  const recover = (
    operation: JournalDomainInputRecoveryOperation,
    openedThrough?: { epoch: string; sequence: number }
  ) =>
    transaction(() =>
      applyJournalDomainInputRecovery(db, target, operation, { openedThrough }, now + 20)
    )
  const command = (operation: JournalDomainCommandTurnOperation) =>
    transaction(() => applyJournalDomainCommandTurn(db, target, operation, now + 30))
  const seed = (id: string, body = message(id)) =>
    insertJournalDomainQueueRow(db, target, {
      messageId: id,
      body,
      position: 3,
      fingerprint: agentSessionSendBodyFingerprint('chat', body),
      state: 'waiting',
      holdReason: null,
      returnedReason: null,
      returnedRejection: null,
      consumedAs: null,
      queuedAt: { epoch: 'epoch', sequence: 1 }
    })
  return {
    get db() {
      return db
    },
    transaction,
    admit,
    dispatch,
    recover,
    command,
    seed,
    restart: () => {
      db.close()
      db = new Database(filename)
    },
    attempt: (id: string) => readJournalDomainSubmissionAttempt(db, target, id),
    card: (id: string) => journalDomainQueueRow(db, target, id)?.card,
    item: (id: string) => readJournalDomainDispatchItem(db, target, id)?.item,
    head: () => ({
      epoch: 'epoch',
      sequence: Number(
        db.prepare('SELECT last_sequence FROM journal_chat_state').get()!.last_sequence
      )
    })
  }
}

/** Closes and removes every fixture made since the last call. */
export function cleanUpInputRecoveryFixtures(): void {
  for (const cleanup of cleanups.splice(0)) {
    cleanup()
  }
}
