import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import Database from '../sqlite/sync-database'
import { migrateJournalDomainSchema } from '../native-chat/agent-session-journal/journal-domain-schema'
import { ensureAgentSessionAttachmentClaimTables } from '../native-chat/agent-session-attachments/agent-session-attachment-claims'
import { applyJournalDomainSubmission } from '../native-chat/agent-session-journal/journal-domain-submission-admission'
import { applyJournalDomainDispatch } from '../native-chat/agent-session-journal/journal-domain-dispatch'
import { applyJournalDomainItem } from '../native-chat/agent-session-journal/journal-domain-item'
import { readJournalDomainOperationWindow } from '../native-chat/agent-session-journal/journal-domain-operation-window'
import { JournalSqlScope } from '../native-chat/agent-session-journal/journal-sql-scope'
import type { ResolveDispatchInput } from '../native-chat/agent-session-journal/journal-store-contracts'
import { codexTurnLifecycleIdentity } from '../codex/structured/journal/codex-structured-journal-translation-turns'
import { codexProviderHandle } from '../../shared/agent-session/lifecycle/provider-handles/agent-session-provider-handle-encoding'
import { agentSessionSendBodyFingerprint } from '../../shared/agent-session/requests/structured-agent-session-send-mutation'
import {
  agentJournalItemKey,
  agentJournalSubmissionKey
} from '../../shared/agent-session/journal/agent-session-journal-item-key'
import type {
  AgentJournalMessageItem,
  AgentJournalTurnLifecycleState
} from '../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentJournalTurnOutcome } from '../../shared/agent-status/lifecycle/agent-turn-outcome'
import { watchBotTurnEnds } from './bot-run-turn-watch'

const target = { sessionId: 'chat', epoch: 'epoch' }
const cleanups: (() => void)[] = []
afterEach(() => cleanups.splice(0).forEach((cleanup) => cleanup()))

/** A real Codex chat journal, written by the same writers the host uses. */
function codexJournal() {
  const directory = mkdtempSync(join(tmpdir(), 'orca-bot-run-turn-'))
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
  const turn = codexTurnLifecycleIdentity('chat', 'turn-1')
  return {
    turnItemId: agentJournalItemKey(turn),
    admit: (id: string): string => {
      const body: AgentJournalMessageItem = {
        kind: 'message',
        role: 'user',
        blocks: [{ type: 'text', text: id }]
      }
      const payloadFingerprint = agentSessionSendBodyFingerprint('chat', body)
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
              payloadFingerprint,
              fence: 1,
              origin: 'client',
              source: { kind: 'user' },
              handoverRecorded: true
            }
          },
          facts,
          now++
        )
      )
      return payloadFingerprint
    },
    dispatch: (input: ResolveDispatchInput) =>
      transaction(() => applyJournalDomainDispatch(db, target, { kind: 'dispatch', input }, now++)),
    /** Codex echoes each accepted send keyed by the turn it ran in. */
    accept: (clientMessageId: string, ordinal: number) =>
      transaction(() =>
        applyJournalDomainDispatch(
          db,
          target,
          {
            kind: 'dispatch',
            input: {
              clientMessageId,
              state: 'accepted',
              providerIdentity: {
                provider: 'codex',
                threadId: 'thread',
                turnId: 'turn-1',
                ordinal
              },
              fence: 1
            }
          },
          now++
        )
      ),
    writeTurn: (state: AgentJournalTurnLifecycleState, outcome?: AgentJournalTurnOutcome) =>
      transaction(() =>
        applyJournalDomainItem(
          db,
          target,
          {
            kind: 'item',
            identity: turn,
            body: {
              kind: 'turn',
              turnId: 'turn-1',
              state,
              ...(outcome ? { outcome } : {}),
              userItemId: agentJournalSubmissionKey('person')
            },
            options: { turnScope: { kind: 'thread' }, fence: 1 }
          },
          now++
        )
      ),
    window: () =>
      readJournalDomainOperationWindow(new JournalSqlScope(db, 'chat', 'epoch'), {
        operationIds: ['run']
      })
  }
}

it('waits for the turn a run was steered into, and fails when that turn fails', async () => {
  const journal = codexJournal()
  journal.admit('person')
  journal.dispatch({
    clientMessageId: 'person',
    state: 'pending',
    turnScope: { kind: 'thread' },
    fence: 1
  })
  journal.writeTurn('running')
  journal.accept('person', 0)
  const fingerprint = journal.admit('run')
  journal.dispatch({
    clientMessageId: 'run',
    state: 'pending',
    turnScope: { kind: 'turn', turnItemId: journal.turnItemId },
    fence: 1
  })
  journal.accept('run', 1)

  let emit: (event: { type: string; completion?: { sessionId: string } }) => void = () => {}
  let reads = 0
  const host = {
    subscribeTurnCompletions: (listener: { emit: typeof emit }) => {
      emit = listener.emit
      return () => {}
    },
    subscribe: async () => () => {},
    history: async () => ({ ok: false }),
    currentWork: async () => null,
    journalReads: async () => ({
      operationWindow: async () => {
        reads += 1
        return journal.window()
      }
    })
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fake implements every host read the watch makes; its journal reads are the real ones
  const watch = watchBotTurnEnds(host as never)
  let settled = false
  const ended = watch
    .next({ sessionId: 'chat', clientMessageId: 'run', fingerprint })
    .finally(() => (settled = true))
  await vi.waitFor(() => expect(reads).toBe(1))
  // The shared turn still runs: the run has not ended.
  expect(settled).toBe(false)

  journal.writeTurn('completed', 'failure')
  emit({ type: 'completion', completion: { sessionId: 'chat' } })
  // A failed ending, never the other message's answer: delivery records it failed, with Rerun.
  expect(await ended).toMatchObject({ outcome: 'failure', message: '' })
})
