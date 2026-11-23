import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { agentSessionFailureFact } from '../../../../shared/agent-session/failures/agent-session-failure'
import { agentSessionFailureWords } from '../../../../shared/agent-session/failures/agent-session-failure-words'
import type { AgentJournalMessageItem } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import { agentSessionSendBodyFingerprint } from '../../../../shared/agent-session/requests/structured-agent-session-send-mutation'
import { ensureAgentSessionAttachmentClaimTables } from '../../agent-session-attachments/agent-session-attachment-claims'
import Database from '../../../sqlite/sync-database'
import type { JournalStopEvent } from '../durable-rows/journal-row-schema'
import { applyJournalDomainControlCommand } from '../journal-domain-control-command'
import { applyJournalDomainDispatch } from '../journal-domain-dispatch'
import { migrateJournalDomainSchema } from '../journal-domain-schema'
import { applyJournalDomainSubmission } from '../journal-domain-submission-admission'
import { readJournalConnectorReplies } from './journal-connector-replies-read'

// The real journal writer: a Slack send, the Stops, and its rejection as the agent reports it.
const NOW = 1_800_000_000_000
const target = { sessionId: 'chat-1', epoch: 'e' }
let dir = ''
let db: Database
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orca-stop-withdrawal-'))
  db = new Database(join(dir, 'journal.db'))
  migrateJournalDomainSchema(db)
  ensureAgentSessionAttachmentClaimTables(db)
  db.prepare(
    `INSERT INTO journal_chat_state(workspace_id,session_id,epoch,last_sequence,highest_fence)
     VALUES('workspace','chat-1','e',10,1)`
  ).run()
})
afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

const inWriter = (write: () => void) => {
  db.exec('BEGIN IMMEDIATE')
  write()
  db.exec('COMMIT')
}

function send(deliveryId: string): void {
  const body: AgentJournalMessageItem = {
    kind: 'message',
    role: 'user',
    blocks: [{ type: 'text', text: 'pick up the new log' }],
    connectorDelivery: {
      account: 'account-a',
      conversation: { source: 'slack', externalId: 'slack:T1:C1:1.2' },
      deliveryId
    }
  }
  inWriter(() =>
    applyJournalDomainSubmission(
      db,
      dir,
      target,
      {
        kind: 'submission',
        input: {
          clientMessageId: deliveryId,
          body,
          payloadFingerprint: agentSessionSendBodyFingerprint('chat-1', body),
          fence: 1,
          handoverRecorded: true,
          origin: 'client',
          source: { kind: 'user' }
        }
      },
      {
        identity: {
          ...target,
          workspaceId: 'workspace',
          hostId: 'host',
          agent: 'claude',
          providerHandle: null
        }
      },
      NOW
    )
  )
}

// Handed to the agent, which holds it as input to a running turn (a steer).
const handOver = (deliveryId: string) =>
  inWriter(() =>
    applyJournalDomainDispatch(
      db,
      target,
      {
        kind: 'dispatch',
        input: {
          clientMessageId: deliveryId,
          fence: 1,
          state: 'pending',
          turnScope: { kind: 'thread' }
        }
      },
      NOW
    )
  )

const stop = (reason: JournalStopEvent['reason'], at: number) =>
  inWriter(() =>
    applyJournalDomainControlCommand(
      db,
      target,
      { kind: 'stop-accept', event: { reason }, fence: 1, liveTurnId: null },
      {},
      at
    )
  )

// The agent drops the input it was holding, as Claude does on an interrupt.
const rejectAsCancelled = (deliveryId: string, at: number, keptAsCard?: string) =>
  inWriter(() =>
    applyJournalDomainDispatch(
      db,
      target,
      {
        kind: 'dispatch',
        input: {
          clientMessageId: deliveryId,
          fence: 1,
          state: 'rejected',
          ...(keptAsCard ? { keptAsQueuedMessageId: keptAsCard } : {}),
          ...agentSessionFailureWords(agentSessionFailureFact('cancelled'), {
            surface: 'rejection'
          })
        }
      },
      at
    )
  )

const outcomeOf = (deliveryId: string) =>
  readJournalConnectorReplies(db).find((row) => row.deliveryId === deliveryId)?.fill?.outcome ??
  null

it('keeps a send a person’s Stop took back as stopped, even after a later Stop', () => {
  send('d1')
  handOver('d1')
  stop('user-stop', NOW + 1)
  rejectAsCancelled('d1', NOW + 2)
  stop('user-stop', NOW + 3)
  expect(outcomeOf('d1')).toBe('withdrawn')
})

it('leaves a send Orca’s own stop rejected to be reported as it failed', () => {
  send('d1')
  handOver('d1')
  stop('host-stop', NOW + 1)
  rejectAsCancelled('d1', NOW + 2)
  expect(outcomeOf('d1')).toBeNull()
})

it('leaves a send kept as a waiting card owed, since it still runs later', () => {
  send('d1')
  handOver('d1')
  stop('user-stop', NOW + 1)
  rejectAsCancelled('d1', NOW + 2, 'card-d1')
  expect(outcomeOf('d1')).toBeNull()
})

it('reads a queued send a person’s Stop withdrew as stopped', () => {
  send('d1')
  stop('user-stop', NOW + 1)
  stop('user-stop', NOW + 2)
  expect(outcomeOf('d1')).toBe('withdrawn')
})
