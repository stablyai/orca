// An earlier build kept queued cards in their own table. They move into the chat's journal: the
// queue reads each the same before and after, each action moves only its own card, and the bulk
// import runs once per open, all-or-nothing, until no readable legacy row is left.

import type { AgentSessionExecutionOptions } from '../../../shared/agent-session-execution-options'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { agentJournalSubmissionKey } from '../../../shared/agent-session-journal-item-key'
import { agentSessionFailureFact } from '../../../shared/agent-session-failure'
import { agentSessionFailureWords } from '../../../shared/agent-session-failure-words'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalMessageItem
} from '../../../shared/agent-session-journal-types'
import { activeProviderContext } from '../../../shared/agent-session-provider-context'
import { projectStructuredAgentSessionMessages } from '../../../shared/structured-agent-session-message-projection'
import { structuredAgentSessionCommandTurnIdentity } from '../../../shared/structured-agent-session-command-turn-identity'
import { agentSessionSendBodyFingerprint } from '../../../shared/structured-agent-session-send-mutation'
import { openTestJournalHostDatabase } from '../agent-session-journal/journal-host-database-test-support'
import { AgentSessionJournal } from '../agent-session-journal/journal-store'
import {
  HOST_TEST_SESSION as SESSION,
  hostTestOperationId
} from './structured-agent-session-host-test-data'
import {
  createQueuedMessageTestRig,
  eventually,
  QUEUED_RIG_CALLER as CALLER,
  type QueuedMessageTestRig
} from './structured-agent-session-queued-message-rig.test-fixture'

let rig: QueuedMessageTestRig

beforeEach(async () => {
  rig = await createQueuedMessageTestRig({ restartable: true, rewind: async () => ({ ok: true }) })
})

afterEach(() => rig.dispose())

const db = () => openTestJournalHostDatabase(rig.root).db
const message = (text: string): AgentJournalMessageItem => ({
  kind: 'message',
  role: 'user',
  blocks: [{ type: 'text', text }],
  ...(text === '/compact' ? { command: { name: 'compact' } } : {})
})
const words = (fact: 'providerRejected' | 'cancelled') =>
  agentSessionFailureWords(
    fact === 'providerRejected'
      ? agentSessionFailureFact(fact, { detail: { text: 'refused', audience: 'person' } })
      : agentSessionFailureFact(fact),
    { surface: 'rejection' }
  )

function journalFor(sessionId: string): AgentSessionJournal {
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

/** An earlier build's hand-off of `card`, answered `as`. */
async function handOff(
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

type Legacy = [id: string, state: string, text: string | null, consumedAs?: string, hold?: string]

function seedLegacy(sessionId: string, rows: readonly Legacy[]): void {
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

const legacyIds = (sessionId = SESSION) =>
  db()
    .prepare('SELECT message_id AS id FROM queued_messages WHERE session_id = ? ORDER BY position')
    .all(sessionId)
    .map((row) => (typeof row === 'object' && row !== null && 'id' in row ? row.id : null))

/** Each queue row on disk: its card, op and whether it saved a refusal. */
function queueRows(sessionId = SESSION): string[] {
  return db()
    .prepare('SELECT row_json FROM journal_rows WHERE session_id = ? ORDER BY seq')
    .all(sessionId)
    .flatMap((row) => {
      const json = typeof row === 'object' && row !== null && 'row_json' in row ? row.row_json : ''
      const parsed: unknown = JSON.parse(String(json))
      if (typeof parsed !== 'object' || parsed === null || !('kind' in parsed)) {
        return []
      }
      if (parsed.kind !== 'queue' || !('messageId' in parsed) || !('change' in parsed)) {
        return []
      }
      const change = JSON.stringify(parsed.change)
      const op = /"op":"(\w+)"/.exec(change)?.[1]
      return [`${String(parsed.messageId)}:${op}${change.includes('"returned"') ? '+refusal' : ''}`]
    })
}

async function nothingSentTo(...cards: string[]): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 100))
  for (const card of cards) {
    expect(await rig.handoff(card)).toBeUndefined()
  }
}

it("moves an earlier build's cards into the journal, each action its own card, the rest once per open", async () => {
  // An earlier build's chat: its hand-offs are journal rows, its cards rows of their own table.
  await rig.drafts()
  await rig.host.close(SESSION, 'evict')
  const earlier = journalFor(SESSION)
  await earlier.open()
  await handOff(earlier, 'att-present', 'ret-present', 'returned here', 'providerRejected')
  await handOff(
    earlier,
    'att-refused',
    'disp-refused',
    'refused, never settled',
    'providerRejected'
  )
  // Stopped after hand-over, which that build sent back to waiting: the agent may have them.
  await handOff(earlier, 'att-stopped', 'stopped-same', 'stopped, unchanged', 'cancelled')
  await handOff(earlier, 'att-edited', 'stopped-edited', 'stopped, then edited', 'cancelled')
  await earlier.close()
  seedLegacy(SESSION, [
    ['ret-present', 'returned', 'returned here, edited', 'att-present'],
    ['ret-gone', 'returned', 'returned in a lost epoch', 'att-gone'],
    ['cmd-gone', 'returned', '/compact', 'att-cmd'],
    ['disp-refused', 'dispatched', 'refused, never settled', 'att-refused'],
    ['stopped-same', 'waiting', 'stopped, unchanged'],
    ['stopped-edited', 'waiting', 'stopped, then edited, changed'],
    ['orphan', 'dispatched', 'its hand-off is gone', 'att-orphan'],
    ['edited', 'waiting', 'waiting, edited'],
    ['held', 'waiting', 'its send failed', undefined, 'send_failed'],
    ['gone', 'withdrawn', 'deleted'],
    ['broken', 'waiting', null]
  ])
  const all = legacyIds()

  // The first open's import fails: nothing moves, and the view reads every card as it will.
  db().exec(`CREATE TEMP TRIGGER fail_import BEFORE DELETE ON queued_messages
    BEGIN SELECT RAISE(ABORT, 'disk full'); END`)
  const warned = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  const published = [
    { messageId: 'ret-present', state: 'returned' },
    { messageId: 'ret-gone', state: 'returned' },
    { messageId: 'cmd-gone', state: 'returned' },
    { messageId: 'disp-refused', state: 'returned' },
    { messageId: 'stopped-edited', state: 'waiting', paused: true },
    { messageId: 'edited', state: 'waiting' },
    { messageId: 'held', state: 'waiting', paused: true }
  ]
  expect(await rig.drafts()).toEqual(published)
  const stopped = async () => {
    const { items, submissions } = await rig.host.journalSnapshot(SESSION)
    return projectStructuredAgentSessionMessages(items, [], submissions).find(
      (entry) => entry.id === agentJournalSubmissionKey('att-stopped')
    )
  }
  const live = rig.host.collaboratorsForTests().sessions.get(SESSION)!.journal
  const rawStopped = structuredClone(live.submission('att-stopped'))
  const displayedStopped = await stopped()
  expect(displayedStopped).toMatchObject({
    stoppedBeforeStart: true,
    blocks: [{ type: 'text', text: 'stopped, unchanged' }]
  })
  expect(live.submission('att-stopped')).toEqual(rawStopped)
  await nothingSentTo('stopped-same')
  db().exec('DROP TRIGGER fail_import')
  expect(warned).toHaveBeenCalledWith(
    '[journal-open] queued-message import skipped:',
    expect.objectContaining({ sessionId: SESSION })
  )
  warned.mockRestore()
  expect(legacyIds()).toEqual(all)
  expect(queueRows()).toEqual([])

  // Delete and Send each move only their own card, in the action's transaction.
  const deletion = hostTestOperationId()
  expect(await rig.deleteQueued('ret-present', deletion)).toMatchObject({
    value: { deleted: true }
  })
  const sent = await rig.sendNow('ret-gone')
  expect(sent).toMatchObject({ ok: true, value: { submission: { queuedMessageId: 'ret-gone' } } })
  expect(queueRows()).toEqual([
    'ret-present:queued',
    'ret-present:withdrawn',
    'ret-gone:queued+refusal'
  ])
  expect(legacyIds()).toEqual(all.filter((id) => id !== 'ret-present' && id !== 'ret-gone'))
  // The returned cards ahead still hold the queue.
  await nothingSentTo('edited', 'held')

  // The next open moves the rest in one transaction: answered cards write nothing, and a refusal
  // is written only where its hand-off is not in this epoch.
  await rig.settleAccepted(await rig.handoffId('ret-gone'), 'received-returned-card')
  await rig.restartHostProcess()
  expect(await rig.drafts()).toEqual(published.slice(2))
  expect(legacyIds()).toEqual(['broken'])
  expect(queueRows().slice(3)).toEqual([
    'cmd-gone:queued+refusal',
    'disp-refused:queued',
    'stopped-same:queued',
    'stopped-edited:queued',
    'orphan:queued',
    'edited:queued',
    'held:queued'
  ])
  // Unchanged, it is spent on that hand-off: drawn as the person's send its Stop took back.
  expect(await stopped()).toEqual(displayedStopped)

  // The command card's own turn reports its refusal later: it is spent, not left holding the queue.
  const adopted = rig.host.collaboratorsForTests().sessions.get(SESSION)!.journal
  await adopted.appendItem(
    structuredAgentSessionCommandTurnIdentity('att-cmd'),
    { kind: 'status', text: 'Compact failed' },
    {
      fence: rig.store.getRecord(SESSION)!.lease.runtimeFence,
      turnScope: AGENT_JOURNAL_THREAD_SCOPE
    }
  )
  expect(await rig.drafts()).toEqual(published.slice(3))
  expect(await rig.deleteQueued('disp-refused')).toMatchObject({ value: { deleted: true } })
  await rig.resume()
  await eventually(async () => expect(await rig.handoff('edited')).toBeDefined())
  await nothingSentTo('held')
  expect((await rig.handoff('stopped-edited'))?.clientMessageId).toBe('att-edited')
  // Edited since, it waits for its own Send.
  expect(await rig.sendNow('stopped-edited')).toMatchObject({ ok: true })
  const resent = await rig.handoffId('stopped-edited')
  expect(resent).not.toBe('att-edited')
  await rig.settleAccepted(resent, 'resent')

  // A third open finds nothing to move, and an old Delete still answers from its receipt.
  const rows = queueRows()
  await rig.restartHostProcess()
  await rig.drafts()
  expect(queueRows()).toEqual(rows)
  expect(await stopped()).toEqual(displayedStopped)
  expect(legacyIds()).toEqual(['broken'])
  expect(await rig.deleteQueued('ret-present', deletion)).toMatchObject({
    replayed: true,
    value: { deleted: true }
  })

  // A chat holding only answered legacy rows has nothing to write: they go in a transaction alone.
  const other = journalFor('session-y')
  await other.open()
  await handOff(other, 'y-att', 'y-sent', 'delivered', 'accepted')
  await other.close()
  seedLegacy('session-y', [
    ['y-gone', 'withdrawn', 'deleted'],
    ['y-sent', 'dispatched', 'delivered', 'y-att']
  ])
  const reopened = journalFor('session-y')
  await reopened.open()
  expect(legacyIds('session-y')).toEqual([])
  expect(queueRows('session-y')).toEqual([])
  expect(reopened.queuedMessages.list()).toEqual([])
  await reopened.close()
})

it('a rewind while import fails preserves canonical refusals and leaves legacy cleanup optional', async () => {
  // Made before the clear, which leaves the chat no provider handle to read.
  const earlier = journalFor(SESSION)
  const clear = { command: 'clear' as const }
  expect(
    await rig.host.conversationCommand(CALLER, {
      ...clear,
      envelope: rig.envelope(clear, 'agentSession.conversationCommand', hostTestOperationId())
    })
  ).toMatchObject({ ok: true })
  const target = rig.send('rewound away')
  expect(await target.result).toMatchObject({ ok: true })
  await eventually(async () =>
    expect((await rig.submission(target.id))?.handedOverAt).toBeDefined()
  )
  await rig.settleAccepted(target.id, 'target')
  await rig.host.close(SESSION, 'evict')
  await earlier.open()
  const fence = rig.store.getRecord(SESSION)!.lease.runtimeFence
  await handOff(
    earlier,
    'att-refused',
    'disp-refused',
    'refused, never settled',
    'providerRejected',
    fence
  )
  await earlier.close()
  seedLegacy(SESSION, [
    ['disp-refused', 'dispatched', 'refused, never settled', 'att-refused'],
    ['edited', 'waiting', 'waiting, edited']
  ])
  db().exec(`CREATE TEMP TRIGGER fail_import BEFORE DELETE ON queued_messages
    BEGIN SELECT RAISE(ABORT, 'disk full'); END`)
  const warned = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  const held = [
    { messageId: 'disp-refused', state: 'returned' },
    { messageId: 'edited', state: 'waiting' }
  ]
  expect(await rig.drafts()).toEqual(held)
  db().exec('DROP TRIGGER fail_import')
  warned.mockRestore()

  const live = rig.host.collaboratorsForTests().sessions.get(SESSION)!.journal
  const rewound = { itemId: agentJournalSubmissionKey(target.id), expectedEpoch: live.epoch }
  expect(
    await rig.host.rewind(CALLER, {
      ...rewound,
      envelope: rig.envelope(rewound, 'agentSession.rewind', hostTestOperationId())
    })
  ).toMatchObject({ ok: true })
  expect(live.epoch).toBe(rewound.expectedEpoch)
  expect(live.submission('att-refused')?.dispatchState).toBe('rejected')
  expect(await rig.drafts()).toEqual(held)
  await nothingSentTo('edited')
  expect(legacyIds()).toEqual(['disp-refused', 'edited'])
})

it.each([false, true])(
  'keeps legacy effective actions and exact proof durable while cleanup fails=%s',
  async (failed) => {
    const session = `legacy-action-${failed}`
    let journal = journalFor(session)
    await journal.open()
    const ids = ['proof', 'deleted', 'edited', 'sent']
    for (const id of ids) {
      await handOff(journal, `U-${id}`, `Q-${id}`, id, 'cancelled', 0, true)
    }
    await journal.close()
    seedLegacy(
      session,
      ids.map((id) => [`Q-${id}`, 'waiting', id])
    )
    if (failed) {
      db().exec(
        `CREATE TEMP TRIGGER fail_import BEFORE DELETE ON queued_messages BEGIN SELECT RAISE(ABORT, 'cleanup unavailable'); END`
      )
    }
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const open = async () => {
      journal = journalFor(session)
      await journal.open()
      journal.queuedMessages.recoveryWork = () => ({
        allowsRecovery: () => true,
        owesSend: () => false,
        generationEnded: () => true,
        activeTurnId: () => null,
        recoveryViewKey: () => ''
      })
    }
    await open()
    for (const id of ids) {
      expect(journal.submission(`U-${id}`)?.dispatchState).toBe('unknown')
      expect(journal.queuedMessages.get(`recovery:U-${id}`)?.state).toBe('returned')
    }
    if (failed) {
      db().exec(
        `CREATE TEMP TRIGGER fail_action BEFORE INSERT ON journal_rows BEGIN SELECT RAISE(ABORT, 'action unavailable'); END`
      )
      await expect(journal.queuedMessages.withdraw(['recovery:U-deleted'])).rejects.toThrow(
        'action unavailable'
      )
      expect(journal.queuedMessages.get('recovery:U-deleted')?.state).toBe('returned')
      expect(legacyIds(session)).toHaveLength(4)
      db().exec('DROP TRIGGER fail_action')
    }
    await journal.acceptLate({
      clientMessageId: 'U-proof',
      state: 'accepted',
      fence: 0,
      providerIdentity: { provider: 'codex', threadId: 'thread', turnId: 'late', ordinal: 0 }
    })
    await journal.queuedMessages.withdraw(['recovery:U-deleted'])
    const edit = journal.queuedMessages.get('recovery:U-edited')!
    expect(
      await journal.queuedMessages.update({
        messageId: edit.messageId,
        expectedBodyFingerprint: edit.fingerprint,
        text: 'changed'
      })
    ).toMatchObject({ status: 'updated' })
    const send = journal.queuedMessages.get('recovery:U-sent')!
    await journal.appendSubmission(
      {
        clientMessageId: 'V',
        body: send.body,
        payloadFingerprint: send.fingerprint,
        fence: 0,
        origin: 'client',
        handoverRecorded: true
      },
      { messageId: send.messageId, expect: 'returned' }
    )
    if (failed) {
      expect(legacyIds(session)).toHaveLength(4)
    }
    await journal.replaceEpochItems('handle_forked', 0, [])
    await journal.close()
    await open()
    expect(journal.submission('U-proof')?.dispatchState).toBe('accepted')
    expect(journal.queuedMessages.get('recovery:U-proof')).toBeNull()
    expect(journal.queuedMessages.get('recovery:U-deleted')?.state).toBe('withdrawn')
    expect(journal.queuedMessages.get('recovery:U-edited')).toMatchObject({
      state: 'waiting',
      body: message('changed')
    })
    expect(journal.queuedMessages.get('recovery:U-sent')).toMatchObject({
      state: 'dispatched',
      consumedAs: 'V'
    })
    expect(
      journal.queuedMessages
        .list()
        .filter((card) => card.messageId.startsWith('Q-'))
        .every((card) => card.state === 'dispatched')
    ).toBe(true)
    expect(journal.submission('V')?.dispatchState).toBe('pending')
    if (failed) {
      expect(legacyIds(session)).toHaveLength(4)
      db().exec('DROP TRIGGER fail_import')
    }
    warned.mockRestore()
    await journal.close()
  }
)

it.each([false, true])(
  'keeps edited prior-build intent independent from original proof with failed cleanup=%s',
  async (failed) => {
    const session = `edited-legacy-${failed}`
    let journal = journalFor(session)
    await journal.open()
    const original = {
      body: {
        ...message('original'),
        blocks: [
          { type: 'text' as const, text: 'original' },
          { type: 'image-ref' as const, path: '/qa/original.png' }
        ]
      },
      options: { model: 'before-edit-model', effort: 'medium' }
    }
    for (const id of ['proof', 'edited', 'deleted', 'sent']) {
      await handOff(journal, `U-${id}`, `Q-${id}`, 'original', 'cancelled', 0, true, original)
    }
    await handOff(journal, 'refusal', 'refused', 'original', 'providerRejected', 0, true)
    await journal.close()
    seedLegacy(
      session,
      ['proof', 'edited', 'deleted', 'sent'].map((id) => [`Q-${id}`, 'waiting', 'independent edit'])
    )
    const editedBody: AgentJournalMessageItem = {
      ...message('independent edit'),
      blocks: [
        { type: 'text', text: 'independent edit' },
        { type: 'image-ref', path: '/qa/prior-image.png' }
      ]
    }
    const options = { model: 'original-model', effort: 'high' }
    db()
      .prepare(
        'UPDATE queued_messages SET body_json = ?, fingerprint = ?, options_json = ? WHERE session_id = ?'
      )
      .run(
        JSON.stringify(editedBody),
        agentSessionSendBodyFingerprint(session, editedBody),
        JSON.stringify(options),
        session
      )
    if (failed) {
      db().exec(
        `CREATE TEMP TRIGGER fail_edited_cleanup BEFORE DELETE ON queued_messages BEGIN SELECT RAISE(ABORT, 'cleanup unavailable'); END`
      )
    }
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const open = async () => {
      journal = journalFor(session)
      await journal.open()
      journal.queuedMessages.recoveryWork = () => ({
        allowsRecovery: () => true,
        owesSend: () => false,
        generationEnded: () => true,
        activeTurnId: () => null,
        recoveryViewKey: () => ''
      })
    }
    await open()
    const independent = journal.queuedMessages.get('Q-proof')!
    expect(independent).toMatchObject({
      state: 'waiting',
      consumedAs: null,
      recovers: 'U-proof',
      body: editedBody,
      options
    })
    expect(journal.submission('U-proof')?.dispatchState).toBe('unknown')
    const before = journal.cursor()
    expect(
      await journal.queuedMessages.update({
        messageId: 'Q-proof',
        expectedBodyFingerprint: independent.fingerprint,
        text: 'independent edit'
      })
    ).toMatchObject({ status: 'unchanged' })
    expect(journal.cursor()).toEqual(before)
    await journal.queuedMessages.update({
      messageId: 'Q-edited',
      expectedBodyFingerprint: independent.fingerprint,
      text: 'second independent edit'
    })
    await journal.queuedMessages.withdraw(['Q-deleted'])
    const send = journal.queuedMessages.get('Q-sent')!
    await journal.appendSubmission(
      {
        clientMessageId: 'V',
        body: send.body,
        payloadFingerprint: send.fingerprint,
        fence: 0,
        origin: 'client',
        handoverRecorded: true,
        options: send.options
      },
      { messageId: 'Q-sent', expect: 'waiting' }
    )
    const proof = async (id: string) =>
      journal.acceptLate({
        clientMessageId: id,
        state: 'accepted',
        fence: 0,
        providerIdentity: { provider: 'codex', threadId: 'thread', turnId: id, ordinal: 0 }
      })
    for (const id of ['proof', 'edited', 'deleted', 'sent']) {
      await proof(`U-${id}`)
      expect(journal.submission(`U-${id}`)?.dispatchState).toBe('accepted')
      expect(journal.receiptFor(`U-${id}`)).not.toBeNull()
      expect(journal.submissionBody(`U-${id}`)).toEqual(original.body)
      expect(journal.submission(`U-${id}`)?.options).toEqual(original.options)
    }
    await proof('refusal')
    expect(journal.submission('refusal')?.dispatchState).toBe('rejected')
    await journal.replaceEpochItems('handle_forked', 0, [])
    await journal.close()
    await open()
    expect(
      journal.queuedMessages.list().some((card) => card.messageId.startsWith('recovery:U-'))
    ).toBe(false)
    expect(journal.queuedMessages.get('Q-proof')).toMatchObject(independent)
    expect(journal.queuedMessages.get('Q-edited')).toMatchObject({
      state: 'waiting',
      recovers: 'U-edited',
      body: {
        ...editedBody,
        blocks: [{ type: 'text', text: 'second independent edit' }, editedBody.blocks[1]]
      },
      options
    })
    expect(journal.queuedMessages.get('Q-deleted')?.state).toBe('withdrawn')
    expect(journal.queuedMessages.get('Q-sent')).toMatchObject({
      state: 'dispatched',
      consumedAs: 'V'
    })
    expect(journal.submission('V')).toMatchObject({ dispatchState: 'pending', options })
    for (const id of ['proof', 'edited', 'deleted', 'sent']) {
      expect(journal.submission(`U-${id}`)?.dispatchState).toBe('accepted')
    }
    if (failed) {
      expect(legacyIds(session)).toHaveLength(4)
      db().exec('DROP TRIGGER fail_edited_cleanup')
    }
    warned.mockRestore()
    await journal.close()
  }
)
