// A chat journal a newer Orca wrote opens read-only here: its cards still show, and every queue
// write (a queued send, Send-now, Delete, Resume) is refused with the words a send gets there.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openTestJournalHostDatabase } from '../agent-session-journal/journal-host-database-test-support'
import { JOURNAL_NEWER_SCHEMA_MESSAGE } from '../agent-session-journal/journal-open-failure'
import { HOST_TEST_SESSION } from './structured-agent-session-host-test-data'
import {
  createQueuedMessageTestRig,
  type QueuedMessageTestRig
} from './structured-agent-session-queued-message-rig.test-fixture'

const REFUSED_BY_NEWER_ORCA = {
  ok: false,
  refusal: {
    code: 'agent_session_journal_unreadable',
    details: { reason: 'journalWrittenByNewerOrca' },
    message: JOURNAL_NEWER_SCHEMA_MESSAGE
  }
}

let rig: QueuedMessageTestRig

beforeEach(async () => {
  rig = await createQueuedMessageTestRig()
})

afterEach(() => rig.dispose())

async function queuedDraft(text: string): Promise<string> {
  const queued = await rig.send(text, 'queue-if-active').result
  if (!queued.ok || !('queued' in queued.value)) {
    throw new Error('expected a queued receipt')
  }
  return queued.value.queued.messageId
}

/** The chat reopens on a database a newer Orca stamped. The host's database object is the one
 *  the rig built, so its open-time verdict is set in place; every store write checks that. */
async function reopenOnNewerOrcaDatabase(close: () => Promise<unknown>): Promise<void> {
  await close()
  Object.defineProperty(openTestJournalHostDatabase(rig.root), 'readOnly', { value: true })
}

/** A read-only journal's history answers as a `schema_unreadable` reset carrying its page. */
async function readOnlyQueue() {
  const answer = await rig.host.history({ sessionId: HOST_TEST_SESSION, direction: 'tail' })
  expect(answer).toMatchObject({ ok: false, reset: 'schema_unreadable' })
  const page = 'page' in answer ? answer.page : undefined
  return {
    cards: (page?.queuedMessages ?? []).map(({ messageId, state }) => ({ messageId, state })),
    pause: page?.queuePause ?? null
  }
}

async function twoCardsBehindWork() {
  await rig.workingSend()
  const first = await queuedDraft('first')
  const second = await queuedDraft('second')
  return {
    first,
    second,
    cards: [
      { messageId: first, state: 'waiting' },
      { messageId: second, state: 'waiting' }
    ]
  }
}

describe("a newer Orca's journal", () => {
  it('shows the cards, and refuses a queued send, Send-now and Delete with the update words', async () => {
    const { first, second, cards } = await twoCardsBehindWork()
    await reopenOnNewerOrcaDatabase(() => rig.host.close(HOST_TEST_SESSION))
    expect(await readOnlyQueue()).toEqual({ cards, pause: null })

    // The waiting cards would queue this send behind them; the journal takes no new draft.
    expect(await rig.send('third', 'queue-if-active').result).toMatchObject(REFUSED_BY_NEWER_ORCA)
    expect(await rig.sendNow(first)).toMatchObject(REFUSED_BY_NEWER_ORCA)
    expect(await rig.deleteQueued(second)).toMatchObject(REFUSED_BY_NEWER_ORCA)

    expect(await readOnlyQueue()).toEqual({ cards, pause: null })
  })

  it('refuses Resume of the queue a restart paused with the update words', async () => {
    const { cards } = await twoCardsBehindWork()
    await reopenOnNewerOrcaDatabase(() => rig.restartHostProcess())
    expect(await readOnlyQueue()).toEqual({ cards, pause: { reason: 'restarted' } })

    expect(await rig.resume()).toMatchObject(REFUSED_BY_NEWER_ORCA)

    expect(await readOnlyQueue()).toEqual({ cards, pause: { reason: 'restarted' } })
  })
})
