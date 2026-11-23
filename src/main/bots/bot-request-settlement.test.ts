import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import Database from '../sqlite/sync-database'
import { migrateJournalDomainSchema } from '../native-chat/agent-session-journal/journal-domain-schema'
import { ensureAgentSessionAttachmentClaimTables } from '../native-chat/agent-session-attachments/agent-session-attachment-claims'
import { applyJournalDomainSubmission } from '../native-chat/agent-session-journal/journal-domain-submission-admission'
import { applyJournalDomainDispatch } from '../native-chat/agent-session-journal/journal-domain-dispatch'
import { applyJournalDomainItem } from '../native-chat/agent-session-journal/journal-domain-item'
import { readJournalDomainTurnAttribution } from '../native-chat/agent-session-journal/journal-domain-turn-attribution'
import { readJournalDomainOperationWindow } from '../native-chat/agent-session-journal/journal-domain-operation-window'
import { JournalSqlScope } from '../native-chat/agent-session-journal/journal-sql-scope'
import type { ResolveDispatchInput } from '../native-chat/agent-session-journal/journal-store-contracts'
import { agentSessionFailureWords } from '../../shared/agent-session/failures/agent-session-failure-words'
import { OrchestrationDb } from '../runtime/orchestration/db/orchestration-db'
import {
  settleBotRequestFailure,
  settleBotRequestTurn
} from '../runtime/rpc/methods/orchestration/messaging/bot-request-outcome'
import { codexTurnLifecycleIdentity } from '../codex/structured/journal/codex-structured-journal-translation-turns'
import { codexProviderHandle } from '../../shared/agent-session/lifecycle/provider-handles/agent-session-provider-handle-encoding'
import { agentSessionSendBodyFingerprint } from '../../shared/agent-session/requests/structured-agent-session-send-mutation'
import {
  agentJournalItemKey,
  agentJournalSubmissionKey
} from '../../shared/agent-session/journal/agent-session-journal-item-key'
import type * as SessionTabs from './bot-session-tabs'
import type * as ChatSession from './bot-chat-session'
import type { AgentJournalItemIdentity } from '../../shared/agent-session/journal/agent-session-journal-identity'
import type {
  AgentJournalMessageItem,
  AgentJournalTurnJoin
} from '../../shared/agent-session/journal/agent-session-journal-types'
import { testOrcaSessionId } from '../../shared/agent-session/identity/orca-session-address-test-fixture'
import type { BotRequestRecord } from './bot-request-view'

// How a request another agent sent ends back at its asker: the chat's real journal says which turn
// answered it, the real orchestration database holds the request and takes the notice. Stubbed:
// only which bot owns the chat and where the host's journal reads come from.

const live = vi.hoisted((): { reads: unknown } => ({ reads: null }))
vi.mock('./bot-session-tabs', async (original) => ({
  ...(await original<typeof SessionTabs>()),
  botOfSession: () => ({ id: 'helper' })
}))
vi.mock('./bot-chat-session', async (original) => ({
  ...(await original<typeof ChatSession>()),
  requireStructuredHost: async () => ({ journalReads: async () => live.reads })
}))

const target = { sessionId: 'chat', epoch: 'epoch' }
const turnOf = (id: string) => codexTurnLifecycleIdentity('chat', id)
const TURN_A = turnOf('turn-a')
const TURN_B = turnOf('turn-b')
const TURN_R = turnOf('turn-r')

let directory = ''
let journalDb: Database
let db: OrchestrationDb
let runId = ''
let now = 1_800_000_000_000
let ordinal = 0

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'orca-bot-request-settlement-'))
  journalDb = new Database(join(directory, 'journal.sqlite'))
  migrateJournalDomainSchema(journalDb)
  ensureAgentSessionAttachmentClaimTables(journalDb)
  journalDb
    .prepare(`INSERT INTO journal_chat_state(session_id,workspace_id,epoch,last_sequence,highest_fence)
    VALUES('chat','workspace','epoch',0,1)`)
    .run()
  const scope = () => new JournalSqlScope(journalDb, 'chat', 'epoch')
  live.reads = {
    turnAttribution: async (turnId: string, through: number) =>
      readJournalDomainTurnAttribution(scope(), turnId, through),
    operationWindow: async (anchors: Parameters<typeof readJournalDomainOperationWindow>[1]) =>
      readJournalDomainOperationWindow(scope(), anchors)
  }
  db = new OrchestrationDb(join(directory, 'orchestration.db'))
  runId = db.createRun({
    objective: 'asker',
    coordinatorHandle: null,
    coordinatorPaneKey: null,
    coordinatorOrcaSessionId: testOrcaSessionId('00000000-0000-4000-8000-00000000a5c0')
  }).id
})
afterEach(() => {
  journalDb.close()
  db.close()
  rmSync(directory, { recursive: true, force: true })
})

const runtime = () =>
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: settlement reads only these runtime members on this path
  ({
    getOrchestrationDb: () => db,
    bots: { list: () => [] },
    ensureStructuredAgentSessionHost: async () => {},
    notifyMessageArrived: () => {}
  }) as never

const ASKER = () => `run:${runId}`

/** Another agent's handoff to this chat, admitted as the orchestration database admits it. */
function request(subject: string): string {
  const record: BotRequestRecord = {
    fromBotId: 'asker',
    fromBotName: 'Asker',
    toBotId: 'helper',
    toBotName: 'Helper',
    purpose: 'handoff',
    depth: 1,
    askers: [],
    request: null,
    conversation: null
  }
  const admitted = db.admitBotRequest({
    rootKey: subject,
    fromBotId: 'asker',
    toBotId: 'helper',
    purpose: 'handoff',
    depth: 1,
    record: JSON.stringify(record),
    message: { from: ASKER(), to: 'orca_session_id:chat', subject, type: 'handoff', runId }
  })
  if (admitted.kind !== 'sent') {
    throw new Error(`not admitted: ${admitted.kind}`)
  }
  return admitted.message.id
}

const transaction = <T>(run: () => T): T => {
  journalDb.exec('BEGIN IMMEDIATE')
  try {
    const value = run()
    journalDb.exec('COMMIT')
    return value
  } catch (error) {
    journalDb.exec('ROLLBACK')
    throw error
  }
}

const facts = {
  identity: {
    sessionId: 'chat',
    workspaceId: 'workspace',
    hostId: 'host',
    agent: 'codex' as const,
    providerHandle: codexProviderHandle('thread')
  }
}

/** Mail to the chat noticing `messageId` (a request, or a worker's report when no request). */
const mail = (id: string, messageId: string): AgentJournalMessageItem => ({
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
      messages: [{ messageId, runId, from: 'asker' }]
    }
  }
})

/** Admitted while `scoped` runs (the host's handover scope), then the provider's verdict on it. */
function send(
  id: string,
  messageId: string,
  scoped: AgentJournalItemIdentity | null,
  answered: { turn: AgentJournalItemIdentity; via: AgentJournalTurnJoin } | 'refused'
): void {
  const body = mail(id, messageId)
  transaction(() =>
    applyJournalDomainSubmission(
      journalDb,
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
  const dispatch = (input: ResolveDispatchInput) =>
    transaction(() =>
      applyJournalDomainDispatch(journalDb, target, { kind: 'dispatch', input }, now++)
    )
  dispatch({
    clientMessageId: id,
    fence: 1,
    state: 'pending',
    turnScope: scoped
      ? { kind: 'turn', turnItemId: agentJournalItemKey(scoped) }
      : { kind: 'thread' }
  })
  dispatch(
    answered === 'refused'
      ? { clientMessageId: id, fence: 1, state: 'rejected', ...REFUSED }
      : {
          clientMessageId: id,
          fence: 1,
          state: 'accepted',
          providerIdentity: {
            provider: 'codex',
            threadId: 'thread',
            turnId: 'echo',
            ordinal: ordinal++
          },
          answeredInTurn: answered
        }
  )
}

const REFUSED = agentSessionFailureWords({ kind: 'notSignedIn' }, { surface: 'rejection' })

/** The provider's turn `turnId` (its row keyed by turnOf), opened by `openerId`. */
function turn(turnId: string, openerId: string, state: 'running' | 'success' | 'failure'): void {
  transaction(() =>
    applyJournalDomainItem(
      journalDb,
      target,
      {
        kind: 'item',
        identity: turnOf(turnId),
        body: {
          kind: 'turn',
          turnId,
          state: state === 'running' ? 'running' : 'completed',
          ...(state === 'running' ? {} : { outcome: state }),
          userItemId: agentJournalSubmissionKey(openerId)
        },
        options: { turnScope: { kind: 'thread' }, fence: 1 }
      },
      now++
    )
  )
}

/** The notices the asker got, by what they said. */
const notices = (): string[] =>
  db.db
    .prepare('SELECT body FROM messages WHERE to_handle = ? ORDER BY created_at')
    .all(ASKER())
    .map((row) => (row && typeof row === 'object' && 'body' in row ? String(row.body) : ''))

const failedTurn = (id: string, kind: 'turn' | 'refused-send' = 'turn') => ({
  sessionId: 'chat',
  agent: 'codex',
  kind,
  id,
  outcome: 'failure' as const,
  read: async () => null
})

it('tells the asker of a request folded into a turn when that turn ends, and not the one whose steer was refused', async () => {
  const r1 = request('first')
  const r2 = request('folded')
  const r3 = request('refused steer')
  send('m1', r1, null, { turn: TURN_A, via: 'start' })
  turn('turn-a', 'm1', 'running')
  send('m2', r2, TURN_A, { turn: TURN_A, via: 'steer' })
  // Scoped to A at handover, but the provider ran it as its own turn B.
  send('m3', r3, TURN_A, { turn: TURN_B, via: 'start' })
  turn('turn-a', 'm1', 'success')

  await settleBotRequestTurn(runtime(), 'chat', 'turn-a', { outcome: 'success' })
  expect(notices()).toEqual([
    expect.stringContaining('Helper read your handoff and ended its turn without a reply'),
    expect.stringContaining('Helper read your handoff and ended its turn without a reply')
  ])
  expect([r1, r2, r3].map((id) => db.getBotRequestOutcome(id))).toEqual([
    'unanswered',
    'unanswered',
    null
  ])

  turn('turn-b', 'm3', 'success')
  await settleBotRequestTurn(runtime(), 'chat', 'turn-b', { outcome: 'success' })
  expect(db.getBotRequestOutcome(r3)).toBe('unanswered')
})

it('tells the asker its request failed when the turn that answered it fails', async () => {
  const r1 = request('first')
  const r2 = request('folded')
  send('m1', r1, null, { turn: TURN_A, via: 'start' })
  turn('turn-a', 'm1', 'running')
  send('m2', r2, TURN_A, { turn: TURN_A, via: 'steer' })
  turn('turn-a', 'm1', 'failure')

  await settleBotRequestFailure(runtime(), failedTurn(agentJournalItemKey(TURN_A)))
  expect(notices()).toEqual([
    expect.stringContaining("Helper's turn failed with an error. It ended without answering"),
    expect.stringContaining("Helper's turn failed with an error. It ended without answering")
  ])
})

it('a refused send of agent mail that is no request settles nothing else', async () => {
  const r1 = request('first')
  send('m1', r1, null, { turn: TURN_A, via: 'start' })
  turn('turn-a', 'm1', 'success')
  // R1 is still open (its workers ran on); a worker's report to the chat is then refused.
  send('report', 'worker-report', null, 'refused')

  await settleBotRequestFailure(
    runtime(),
    failedTurn(agentJournalSubmissionKey('report'), 'refused-send')
  )
  expect(notices()).toEqual([])
  expect(db.getBotRequestOutcome(r1)).toBeNull()
})

it('a turn whose rows say it answered nothing settles nothing', async () => {
  const r1 = request('first')
  send('m1', r1, null, { turn: TURN_A, via: 'start' })
  turn('turn-a', 'm1', 'success')
  // A turn with no opener on record and nothing steered into it.
  turn('turn-r', 'never-sent', 'success')

  await settleBotRequestTurn(runtime(), 'chat', 'turn-r', { outcome: 'success' })
  expect(notices()).toEqual([])
  expect(db.getBotRequestOutcome(r1)).toBeNull()
})

it('a turn woken by a worker report settles the acting turn before it, never one opened since', async () => {
  const r1 = request('first')
  const r2 = request('second')
  send('m1', r1, null, { turn: TURN_A, via: 'start' })
  turn('turn-a', 'm1', 'success')
  // A's workers report; that turn ends.
  send('report', 'worker-report', null, { turn: TURN_R, via: 'start' })
  turn('turn-r', 'report', 'success')
  // Before its settlement reads the journal, a new request opens turn B.
  send('m2', r2, null, { turn: TURN_B, via: 'start' })
  turn('turn-b', 'm2', 'running')

  await settleBotRequestTurn(runtime(), 'chat', 'turn-r', { outcome: 'success' })
  expect([r1, r2].map((id) => db.getBotRequestOutcome(id))).toEqual(['unanswered', null])
})
