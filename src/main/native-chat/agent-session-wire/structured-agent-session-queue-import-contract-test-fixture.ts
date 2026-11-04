import { seedTestLegacyQueueRows } from '../agent-session-journal/journal-native-fixture-test-support'
import { afterEach, beforeEach, expect } from 'vitest'
import { agentSessionFailureFact } from '../../../shared/agent-session/failures/agent-session-failure'
import { agentSessionFailureWords } from '../../../shared/agent-session/failures/agent-session-failure-words'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalAnsweredTurnIdentity,
  type AgentJournalMessageItem
} from '../../../shared/agent-session/journal/agent-session-journal-types'
import { activeProviderContext } from '../../../shared/agent-session/agent-session-provider-context'
import { agentSessionSendBodyFingerprint } from '../../../shared/agent-session/requests/structured-agent-session-send-mutation'
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

export const db = async () => await openTestJournalHostDatabase(rig.root)

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

export async function journalFor(sessionId: string): Promise<AgentSessionJournal> {
  return new AgentSessionJournal({
    database: await openTestJournalHostDatabase(rig.root),
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

export async function queueRows(sessionId = SESSION): Promise<string[]> {
  return (await readTestQueueChanges(await db(), sessionId)).map(
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
