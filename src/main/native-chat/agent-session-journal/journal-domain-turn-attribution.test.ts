import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import Database from '../../sqlite/sync-database'
import { migrateJournalDomainSchema } from './journal-domain-schema'
import { ensureAgentSessionAttachmentClaimTables } from '../agent-session-attachments/agent-session-attachment-claims'
import { applyJournalDomainSubmission } from './journal-domain-submission-admission'
import { applyJournalDomainDispatch } from './journal-domain-dispatch'
import { applyJournalDomainItem } from './journal-domain-item'
import { readJournalDomainTurnAttribution } from './journal-domain-turn-attribution'
import { JournalSqlScope } from './journal-sql-scope'
import type { ResolveDispatchInput } from './journal-store-contracts'
import { codexTurnLifecycleIdentity } from '../../codex/structured/journal/codex-structured-journal-translation-turns'
import { codexProviderHandle } from '../../../shared/agent-session/lifecycle/provider-handles/agent-session-provider-handle-encoding'
import { agentSessionSendBodyFingerprint } from '../../../shared/agent-session/requests/structured-agent-session-send-mutation'
import {
  agentJournalItemKey,
  agentJournalSubmissionKey
} from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import type { AgentJournalMessageItem } from '../../../shared/agent-session/journal/agent-session-journal-types'

// A naming read answers only "did this turn answer that conversation", reading the fewest sends; it
// must agree with the full read's stamps, or a lost-reply notice is hidden or posted wrongly.

const target = { sessionId: 'chat', epoch: 'epoch' }
const TURN = codexTurnLifecycleIdentity('chat', 'turn-1')
let directory = ''
let db: Database
let now = 1_800_000_000_000
let ordinal = 0

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'orca-turn-attribution-'))
  db = new Database(join(directory, 'journal.sqlite'))
  migrateJournalDomainSchema(db)
  ensureAgentSessionAttachmentClaimTables(db)
  db.prepare(`INSERT INTO journal_chat_state(session_id,workspace_id,epoch,last_sequence,highest_fence)
    VALUES('chat','workspace','epoch',0,1)`).run()
})
afterEach(() => {
  db.close()
  rmSync(directory, { recursive: true, force: true })
})

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

/** A Slack delivery for `thread`, admitted, then steered into TURN when `steered`. */
function delivery(id: string, thread: string, steered: boolean): void {
  const body: AgentJournalMessageItem = {
    kind: 'message',
    role: 'user',
    blocks: [{ type: 'text', text: id }],
    connectorDelivery: {
      account: 'acct',
      conversation: { source: 'slack', externalId: thread },
      deliveryId: id
    }
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
          source: { kind: 'agent' },
          handoverRecorded: true
        }
      },
      {
        identity: {
          sessionId: 'chat',
          workspaceId: 'workspace',
          hostId: 'host',
          agent: 'codex',
          providerHandle: codexProviderHandle('thread')
        }
      },
      now++
    )
  )
  const dispatch = (input: ResolveDispatchInput) =>
    transaction(() => applyJournalDomainDispatch(db, target, { kind: 'dispatch', input }, now++))
  dispatch({
    clientMessageId: id,
    fence: 1,
    state: 'pending',
    turnScope: steered
      ? { kind: 'turn', turnItemId: agentJournalItemKey(TURN) }
      : { kind: 'thread' }
  })
  dispatch({
    clientMessageId: id,
    fence: 1,
    state: 'accepted',
    providerIdentity: { provider: 'codex', threadId: 'thread', turnId: 'echo', ordinal: ordinal++ },
    ...(steered ? { answeredInTurn: { turn: TURN, via: 'steer' as const } } : {})
  })
}

it('a naming read finds the stamp the full read has, from the opener or a steered send', () => {
  delivery('opener', 'thread-a', false)
  transaction(() =>
    applyJournalDomainItem(
      db,
      target,
      {
        kind: 'item',
        identity: TURN,
        body: {
          kind: 'turn',
          turnId: 'turn-1',
          state: 'completed',
          outcome: 'success',
          userItemId: agentJournalSubmissionKey('opener')
        },
        options: { turnScope: { kind: 'thread' }, fence: 1 }
      },
      now++
    )
  )
  delivery('steer-b', 'thread-b', true)
  delivery('steer-c', 'thread-c', true)
  const scope = () => new JournalSqlScope(db, 'chat', 'epoch')
  const read = (externalId?: string) =>
    readJournalDomainTurnAttribution(
      scope(),
      'turn-1',
      Number.MAX_SAFE_INTEGER,
      externalId ? { source: 'slack', externalId } : undefined
    ).stamps?.map((stamp) => stamp.conversation.externalId)
  expect(read()).toEqual(['thread-a', 'thread-b', 'thread-c'])
  expect(read('thread-a')).toEqual(['thread-a'])
  expect(read('thread-c')).toEqual(['thread-c'])
  expect(read('thread-z')).toEqual([])
})
