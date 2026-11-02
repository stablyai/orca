import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  openTestJournalHostDatabase,
  SAVED_BY_NEWER_ORCA
} from '../agent-session-journal/journal-host-database-test-support'
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

/** Stamp the existing rig database with a newer open verdict; writes must honor it too. */
async function reopenOnNewerOrcaDatabase(close: () => Promise<unknown>): Promise<void> {
  await close()
  Object.defineProperty(openTestJournalHostDatabase(rig.root), 'readOnly', { value: true })
}

async function expectHistoryRefused(): Promise<void> {
  await expect(
    rig.host.history({ sessionId: HOST_TEST_SESSION, direction: 'tail' })
  ).rejects.toMatchObject(SAVED_BY_NEWER_ORCA)
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
  it('refuses the history read, a queued send, Send-now and Delete with the update words', async () => {
    const { first, second } = await twoCardsBehindWork()
    await reopenOnNewerOrcaDatabase(() => rig.host.close(HOST_TEST_SESSION, 'evict'))
    await expectHistoryRefused()

    expect(await rig.send('third', 'queue-if-active').result).toMatchObject(REFUSED_BY_NEWER_ORCA)
    expect(await rig.sendNow(first)).toMatchObject(REFUSED_BY_NEWER_ORCA)
    expect(await rig.deleteQueued(second)).toMatchObject(REFUSED_BY_NEWER_ORCA)
    await expectHistoryRefused()
  })

  it('refuses Resume of the queue a restart paused with the update words', async () => {
    await twoCardsBehindWork()
    await reopenOnNewerOrcaDatabase(() => rig.restartHostProcess())
    await expectHistoryRefused()

    expect(await rig.resume()).toMatchObject(REFUSED_BY_NEWER_ORCA)
  })
})
