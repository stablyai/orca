import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  createQueuedMessageTestRig,
  eventually,
  type QueuedMessageTestRig
} from './structured-agent-session-queued-message-rig.test-fixture'
import {
  HOST_TEST_SESSION as SESSION,
  hostTestMessage
} from './structured-agent-session-host-test-data'
import { openTestJournalHostDatabase } from '../agent-session-journal/journal-host-database-test-support'
import { insertQueuedMessage } from '../agent-session-journal/queued-message-table'
import { readQueuePublication } from './structured-agent-session-queued-publication'
import { nextStructuredQueuedMessage } from './structured-agent-session-queued-messages'

let rig: QueuedMessageTestRig

beforeEach(async () => {
  rig = await createQueuedMessageTestRig()
})

afterEach(async () => {
  vi.restoreAllMocks()
  await rig.dispose()
})

function openJournal() {
  const journal = rig.host.collaboratorsForTests().sessions.get(SESSION)?.journal
  if (!journal) {
    throw new Error('expected the conversation open')
  }
  return journal
}

it.each([0, 5, 2000])(
  'uses zero queue SQL on a streamed frame with %i waiting cards',
  async (n) => {
    const working = await rig.workingSend()
    await rig.settleAccepted(working, 'accepted')
    const journal = openJournal()
    vi.spyOn(journal, 'activeTurnId').mockReturnValue('streaming')
    const db = openTestJournalHostDatabase(rig.root).db
    db.exec('BEGIN')
    try {
      for (let i = 0; i < n; i++) {
        insertQueuedMessage(db, {
          sessionId: SESSION,
          messageId: `card-${i}`,
          body: hostTestMessage('x'.repeat(400)),
          fingerprint: `fp-${i}`,
          hostInstance: 'host',
          queuedAt: { epoch: 'epoch', sequence: 1 },
          now: 1
        })
      }
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
    journal.queuedMessages.invalidate()
    const gate = () => ({ record: rig.store.getRecord(SESSION), fence: 1 })
    const first = readQueuePublication(journal, gate)
    const prepare = vi.spyOn(db, 'prepare')
    const pick = vi.spyOn(journal.queuedMessages, 'nextSendable')
    for (let frame = 0; frame < 3; frame++) {
      rig.host['queued'].drain.schedule(SESSION)
      expect(nextStructuredQueuedMessage({ journal, ...gate() })).toBeNull()
      expect(readQueuePublication(journal, gate)).toBe(first)
    }
    expect(pick).not.toHaveBeenCalled()
    expect(prepare.mock.calls.filter(([sql]) => sql.includes('queued_messages'))).toEqual([])
  }
)

it('still settles owed bookkeeping while an agent works', async () => {
  await rig.workingSend()
  const journal = openJournal()
  vi.spyOn(journal.queuedMessages, 'settlementOwed').mockReturnValue(true)
  const settle = vi.spyOn(journal.queuedMessages, 'settleOwed').mockResolvedValue(undefined)
  const pick = vi.spyOn(journal.queuedMessages, 'nextSendable')
  rig.host['queued'].drain.schedule(SESSION)
  await eventually(() => expect(settle).toHaveBeenCalled())
  expect(pick).not.toHaveBeenCalled()
})

it.each(['NUL suffix', 'BLOB JSON'])('sends card b past a corrupt %s head', async (kind) => {
  const working = await rig.workingSend()
  const a = await rig.send('a', 'queue-if-active').result
  const b = await rig.send('b', 'queue-if-active').result
  if (!a.ok || !b.ok || !('queued' in a.value) || !('queued' in b.value)) {
    throw new Error('expected both cards queued')
  }
  const aId = a.value.queued.messageId
  const bId = b.value.queued.messageId
  const json = JSON.stringify(hostTestMessage('a'))
  const stored = kind === 'NUL suffix' ? `${json}\u0000garbage` : Buffer.from(json)
  openTestJournalHostDatabase(rig.root)
    .db.prepare('UPDATE queued_messages SET body_json = ? WHERE message_id = ?')
    .run(stored, aId)
  const journal = openJournal()
  journal.queuedMessages.invalidate()
  expect(journal.queuedMessages.get(aId)).toBeNull()
  expect(journal.queuedMessages.nextSendable()?.messageId).toBe(bId)
  await rig.settleAccepted(working, 'done')
  await eventually(async () => expect(await rig.handoff(bId)).toBeDefined())
  expect(await rig.handoff(aId)).toBeUndefined()
  expect((await rig.handoff(bId))?.queuedMessageId).toBe(bId)
})
