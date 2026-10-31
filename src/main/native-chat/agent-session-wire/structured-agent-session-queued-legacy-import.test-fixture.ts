import { afterEach, beforeEach } from 'vitest'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalMessageItem
} from '../../../shared/agent-session-journal-types'
import { activeProviderContext } from '../../../shared/agent-session-provider-context'
import { agentSessionFailureFact } from '../../../shared/agent-session-failure'
import { agentSessionFailureWords } from '../../../shared/agent-session-failure-words'
import { agentSessionSendBodyFingerprint } from '../../../shared/structured-agent-session-send-mutation'
import { openTestJournalHostDatabase } from '../agent-session-journal/journal-host-database-test-support'
import { AgentSessionJournal } from '../agent-session-journal/journal-store'
import { HOST_TEST_SESSION as SESSION } from './structured-agent-session-host-test-data'
import {
  createQueuedMessageTestRig,
  type QueuedMessageTestRig
} from './structured-agent-session-queued-message-rig.test-fixture'

export { SESSION }
export const threadWrite = { fence: 0, turnScope: AGENT_JOURNAL_THREAD_SCOPE }

export let rig: QueuedMessageTestRig

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
