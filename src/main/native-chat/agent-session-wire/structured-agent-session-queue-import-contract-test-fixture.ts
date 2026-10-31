import { afterEach, beforeEach, expect } from 'vitest'
import { agentSessionFailureFact } from '../../../shared/agent-session-failure'
import { agentSessionFailureWords } from '../../../shared/agent-session-failure-words'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalAnsweredTurnIdentity,
  type AgentJournalMessageItem
} from '../../../shared/agent-session-journal-types'
import { activeProviderContext } from '../../../shared/agent-session-provider-context'
import { agentSessionSendBodyFingerprint } from '../../../shared/structured-agent-session-send-mutation'
import {
  openTestJournalHostDatabase,
  readTestQueueChanges
} from '../agent-session-journal/journal-host-database-test-support'
import { AgentSessionJournal } from '../agent-session-journal/journal-store'
import { HOST_TEST_SESSION as SESSION } from './structured-agent-session-host-test-data'
import {
  createQueuedMessageTestRig,
  type QueuedMessageTestRig
} from './structured-agent-session-queued-message-rig.test-fixture'

let rig: QueuedMessageTestRig

beforeEach(async () => {
  rig = await createQueuedMessageTestRig({ restartable: true, rewind: async () => ({ ok: true }) })
})

afterEach(() => rig.dispose())

export const db = () => openTestJournalHostDatabase(rig.root).db

export const message = (text: string): AgentJournalMessageItem => ({
  kind: 'message',
  role: 'user',
  blocks: [{ type: 'text', text }],
  ...(text === '/compact' ? { command: { name: 'compact' } } : {})
})

export const threadWrite = { fence: 0, turnScope: AGENT_JOURNAL_THREAD_SCOPE }

export const words = (fact: 'providerRejected' | 'cancelled') =>
  agentSessionFailureWords(
    fact === 'providerRejected'
      ? agentSessionFailureFact(fact, { detail: { text: 'refused', audience: 'person' } })
      : agentSessionFailureFact(fact),
    { surface: 'rejection' }
  )

export function journalFor(sessionId: string): AgentSessionJournal {
  return new AgentSessionJournal({
    database: openTestJournalHostDatabase(rig.root),
    identity: {
      sessionId,
      workspaceId: 'workspace-1',
      hostId: 'local',
      agent: 'codex',
      providerHandle: activeProviderContext(rig.store.getRecord(SESSION)!).head!.handle
    }
  })
}

export async function handOff(
  journal: AgentSessionJournal,
  attempt: string,
  card: string,
  text: string,
  as: 'providerRejected' | 'cancelled' | 'accepted',
  fence = 0,
  beforeAnswer?: () => Promise<void>,
  answeredInTurn?: AgentJournalAnsweredTurnIdentity
): Promise<void> {
  const body = message(text)
  const payloadFingerprint = agentSessionSendBodyFingerprint(journal.queuedMessages.sessionId, body)
  await journal.appendSubmission({
    clientMessageId: attempt,
    payloadFingerprint,
    body,
    fence,
    handoverRecorded: true,
    queuedMessageId: card
  })
  await journal.resolveDispatch({
    clientMessageId: attempt,
    state: 'pending',
    fence,
    turnScope: AGENT_JOURNAL_THREAD_SCOPE
  })
  await beforeAnswer?.()
  await journal.resolveDispatch(
    as === 'accepted'
      ? { clientMessageId: attempt, state: 'accepted', providerIdentity: null, fence }
      : { clientMessageId: attempt, state: 'rejected', ...words(as), fence, answeredInTurn }
  )
}

export type Legacy = [
  id: string,
  state: string,
  text: string | null,
  consumedAs?: string,
  hold?: string
]

export function seedLegacy(sessionId: string, rows: readonly Legacy[]): void {
  const insert = db().prepare(
    `INSERT INTO queued_messages (session_id, message_id, position, body_json, fingerprint,
       created_at, host_instance, state, hold_reason, returned_reason, consumed_as)
     VALUES (?, ?, ?, ?, ?, 0, 'earlier', ?, ?, ?, ?)`
  )
  rows.forEach(([id, state, text, consumedAs, hold], index) => {
    const body = text === null ? '{' : JSON.stringify(message(text))
    const print = text === null ? '' : agentSessionSendBodyFingerprint(sessionId, message(text))
    const reason = state === 'returned' ? 'refused before' : null
    insert.run(
      sessionId,
      id,
      index + 1,
      body,
      print,
      state,
      hold ?? null,
      reason,
      consumedAs ?? null
    )
  })
}

export const legacyIds = (sessionId = SESSION) =>
  db()
    .prepare('SELECT message_id AS id FROM queued_messages WHERE session_id = ? ORDER BY position')
    .all(sessionId)
    .map((row) => (typeof row === 'object' && row !== null && 'id' in row ? row.id : null))

export function queueRows(sessionId = SESSION): string[] {
  return readTestQueueChanges(db(), sessionId).map(
    ({ messageId, op, returned }) => `${messageId}:${op}${returned ? '+refusal' : ''}`
  )
}

export async function nothingSentTo(...cards: string[]): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 100))
  for (const card of cards) {
    expect(await rig.handoff(card)).toBeUndefined()
  }
}

export const retainedHistoryCases = [
  { adopt: false, proof: 'none' },
  { adopt: true, proof: 'none' },
  { adopt: false, proof: 'dispatch' },
  { adopt: true, proof: 'item' }
]

export const fixture = {
  get rig() {
    return rig
  },
  set rig(value: typeof rig) {
    rig = value
  }
}
