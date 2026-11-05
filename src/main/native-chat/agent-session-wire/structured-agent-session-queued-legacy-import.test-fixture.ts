import type { AgentSessionExecutionOptions } from '../../../shared/agent-session/options/agent-session-execution-options'
import { afterEach, beforeEach } from 'vitest'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalMessageItem
} from '../../../shared/agent-session/journal/agent-session-journal-types'
import { activeProviderContext } from '../../../shared/agent-session/agent-session-provider-context'
import { agentSessionFailureFact } from '../../../shared/agent-session/failures/agent-session-failure'
import { agentSessionFailureWords } from '../../../shared/agent-session/failures/agent-session-failure-words'
import { agentSessionSendBodyFingerprint } from '../../../shared/agent-session/requests/structured-agent-session-send-mutation'
import {
  openTestJournalHostDatabase,
  seedLegacyTestJournal,
  pinTestJournalInputMode,
  seedTestLegacyQueueRows
} from '../agent-session-journal/journal-host-database-test-support'
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

export const db = () => openTestJournalHostDatabase(rig.root)
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

export async function journalFor(sessionId: string): Promise<AgentSessionJournal> {
  return new AgentSessionJournal({
    database: await db(),
    identity: {
      sessionId,
      workspaceId: 'workspace-1',
      hostId: 'local',
      agent: 'codex',
      providerHandle: activeProviderContext(rig.store.getRecord(SESSION)!).head!.handle
    }
  })
}

/** Prepare a genuinely historical source before any current writer owns this session. */
export async function historicalJournalFor(sessionId: string): Promise<AgentSessionJournal> {
  const journal = await journalFor(sessionId)
  await seedLegacyTestJournal(await db(), { identity: journal['identity'] })
  pinTestJournalInputMode(journal)
  return journal
}

export type Legacy = [
  id: string,
  state: string,
  text: string | null,
  consumedAs?: string,
  hold?: string
]

export async function seedLegacy(sessionId: string, rows: readonly Legacy[]): Promise<void> {
  await seedTestLegacyQueueRows(
    await db(),
    sessionId,
    rows.map(([id, state, text, consumedAs, hold], index) => ({
      messageId: id,
      position: index + 1,
      body: message(text ?? ''),
      ...(text === null ? { rawBodyJson: '{' } : {}),
      fingerprint: text === null ? '' : agentSessionSendBodyFingerprint(sessionId, message(text)),
      state,
      holdReason: hold ?? null,
      returnedReason: state === 'returned' ? 'refused before' : null,
      returnedRejection: null,
      consumedAs: consumedAs ?? null,
      queuedAt: null
    }))
  )
}

export const legacyIds = async (sessionId = SESSION) =>
  (
    await (
      await db()
    ).read((read) =>
      read
        .prepare(
          'SELECT message_id AS id FROM queued_messages WHERE session_id = ? ORDER BY position'
        )
        .all(sessionId)
    )
  ).map((row) => row.id)

/** An earlier build's hand-off of `card`, answered `as`. */
export async function handOff(
  journal: AgentSessionJournal,
  attempt: string,
  card: string,
  text: string,
  as: 'providerRejected' | 'cancelled' | 'accepted',
  fence = 0,
  answered = false,
  full?: { body: AgentJournalMessageItem; options: AgentSessionExecutionOptions }
): Promise<void> {
  const body = full?.body ?? message(text)
  const payloadFingerprint = agentSessionSendBodyFingerprint(journal.queuedMessages.sessionId, body)
  await journal.appendSubmission({
    clientMessageId: attempt,
    payloadFingerprint,
    body,
    fence,
    handoverRecorded: true,
    queuedMessageId: card,
    ...(answered ? { origin: 'client' as const } : {}),
    ...(full ? { options: full.options } : {})
  })
  await journal.resolveDispatch({
    clientMessageId: attempt,
    state: 'pending',
    fence,
    turnScope: AGENT_JOURNAL_THREAD_SCOPE
  })
  await journal.resolveDispatch(
    as === 'accepted'
      ? { clientMessageId: attempt, state: 'accepted', providerIdentity: null, fence }
      : {
          clientMessageId: attempt,
          state: 'rejected',
          ...words(as),
          fence,
          ...(answered
            ? {
                answeredInTurn: {
                  turn: {
                    provider: 'legacy' as const,
                    agent: 'codex',
                    sessionId: 'thread',
                    recordId: 'ended'
                  },
                  via: 'start' as const
                }
              }
            : {})
        }
  )
}
