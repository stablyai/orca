import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import Database from '../sqlite/sync-database'
import { migrateJournalDomainSchema } from '../native-chat/agent-session-journal/journal-domain-schema'
import { ensureAgentSessionAttachmentClaimTables } from '../native-chat/agent-session-attachments/agent-session-attachment-claims'
import { applyJournalDomainSubmission } from '../native-chat/agent-session-journal/journal-domain-submission-admission'
import { applyJournalDomainDispatch } from '../native-chat/agent-session-journal/journal-domain-dispatch'
import { applyJournalDomainItem } from '../native-chat/agent-session-journal/journal-domain-item'
import { readJournalDomainTurnAttribution } from '../native-chat/agent-session-journal/journal-domain-turn-attribution'
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
  AgentJournalTurnJoin
} from '../../shared/agent-session/journal/agent-session-journal-types'
import { botRequestsTurnAnswered } from './bot-turn-answered-requests'

// Which requests a turn's end settles, read through the real journal writers and the turn
// attribution index: those the provider recorded the turn answering, never one the host only
// scoped to it.

const target = { sessionId: 'chat', epoch: 'epoch' }
const cleanups: (() => void)[] = []
afterEach(() => cleanups.splice(0).forEach((cleanup) => cleanup()))

const TURN_A = codexTurnLifecycleIdentity('chat', 'turn-a')
const TURN_B = codexTurnLifecycleIdentity('chat', 'turn-b')
const TURN_C = codexTurnLifecycleIdentity('chat', 'turn-c')

function chatJournal() {
  const directory = mkdtempSync(join(tmpdir(), 'orca-bot-turn-requests-'))
  const db = new Database(join(directory, 'journal.sqlite'))
  cleanups.push(() => {
    db.close()
    rmSync(directory, { recursive: true, force: true })
  })
  migrateJournalDomainSchema(db)
  ensureAgentSessionAttachmentClaimTables(db)
  db.prepare(`INSERT INTO journal_chat_state(session_id,workspace_id,epoch,last_sequence,highest_fence)
    VALUES('chat','workspace','epoch',0,1)`).run()
  const facts = {
    identity: {
      sessionId: 'chat',
      workspaceId: 'workspace',
      hostId: 'host',
      agent: 'codex' as const,
      providerHandle: codexProviderHandle('thread')
    }
  }
  let now = 1_800_000_000_000
  let ordinal = 0
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
  /** Mail carrying another bot's request (`requestId`), or none: a worker's report. */
  const mail = (id: string, requestId: string): AgentJournalMessageItem => ({
    kind: 'message',
    role: 'user',
    blocks: [{ type: 'text', text: id }],
    from: {
      kind: 'agent',
      senders: [],
      orchestration: {
        message: 'mail-notice',
        mailbox: 'chat',
        dispatchId: null,
        messages: [{ messageId: requestId, runId: 'run', from: 'other-bot' }]
      }
    }
  })
  /** Admitted while `scoped` runs (the host's handover scope), then accepted by the provider. */
  const send = (
    id: string,
    requestId: string,
    scoped: typeof TURN_A | null,
    answered: { turn: typeof TURN_A; via: AgentJournalTurnJoin }
  ) => {
    const body = mail(id, requestId)
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
            source: { kind: 'agent' },
            handoverRecorded: true
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
            state: 'pending',
            turnScope: scoped
              ? { kind: 'turn', turnItemId: agentJournalItemKey(scoped) }
              : { kind: 'thread' },
            fence: 1
          }
        },
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
            state: 'accepted',
            providerIdentity: {
              provider: 'codex',
              threadId: 'thread',
              turnId: 'echo',
              ordinal: ordinal++
            },
            answeredInTurn: answered,
            fence: 1
          }
        },
        now++
      )
    )
  }
  const turn = (identity: typeof TURN_A, turnId: string, openerId: string, ended: boolean) =>
    transaction(() =>
      applyJournalDomainItem(
        db,
        target,
        {
          kind: 'item',
          identity,
          body: {
            kind: 'turn',
            turnId,
            state: ended ? 'completed' : 'running',
            ...(ended ? { outcome: 'success' as const } : {}),
            userItemId: agentJournalSubmissionKey(openerId)
          },
          options: { turnScope: { kind: 'thread' }, fence: 1 }
        },
        now++
      )
    )
  const reads = {
    turnAttribution: async (turnId: string, through: number) =>
      readJournalDomainTurnAttribution(new JournalSqlScope(db, 'chat', 'epoch'), turnId, through)
  }
  return { send, turn, reads }
}

const isRequest = (messageId: string) => messageId.startsWith('req-')

it('settles the requests the provider recorded a turn answering, folded ones included', async () => {
  const journal = chatJournal()
  const acting = async () => ['acting-turn-guess']
  journal.send('r1', 'req-1', null, { turn: TURN_A, via: 'start' })
  journal.turn(TURN_A, 'turn-a', 'r1', false)
  // Folded into A by the provider.
  journal.send('r2', 'req-2', TURN_A, { turn: TURN_A, via: 'steer' })
  // Scoped to A at handover, but the steer was refused: it ran as its own turn B.
  journal.send('r3', 'req-3', TURN_A, { turn: TURN_B, via: 'start' })
  journal.turn(TURN_A, 'turn-a', 'r1', true)
  journal.turn(TURN_B, 'turn-b', 'r3', true)

  expect(await botRequestsTurnAnswered(journal.reads, 'turn-a', isRequest, acting)).toEqual([
    'req-1',
    'req-2'
  ])
  // A failed turn is named by its row's item id.
  expect(
    await botRequestsTurnAnswered(journal.reads, agentJournalItemKey(TURN_A), isRequest, acting)
  ).toEqual(['req-1', 'req-2'])
  expect(await botRequestsTurnAnswered(journal.reads, 'turn-b', isRequest, acting)).toEqual([
    'req-3'
  ])
})

it('a turn woken only by a worker report works on the acting turn’s requests', async () => {
  const journal = chatJournal()
  journal.send('report', 'worker-report', null, { turn: TURN_C, via: 'start' })
  journal.turn(TURN_C, 'turn-c', 'report', true)
  expect(
    await botRequestsTurnAnswered(journal.reads, 'turn-c', isRequest, async () => ['req-1'])
  ).toEqual(['req-1'])
})
