import { expect, it, vi } from 'vitest'
import { agentJournalSubmissionKey } from '../../../shared/agent-session-journal-item-key'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
import { projectStructuredAgentSessionMessages } from '../../../shared/structured-agent-session-message-projection'
import { structuredAgentSessionCommandTurnIdentity } from '../../../shared/structured-agent-session-command-turn-identity'
import {
  HOST_TEST_SESSION as SESSION,
  hostTestOperationId
} from './structured-agent-session-host-test-data'
import { eventually } from './structured-agent-session-queued-message-rig.test-fixture'

import {
  fixture,
  db,
  handOff,
  journalFor,
  legacyIds,
  nothingSentTo,
  queueRows,
  seedLegacy
} from './structured-agent-session-queue-import-contract-test-fixture'

it("moves an earlier build's cards into the journal, each action its own card, the rest once per open", async () => {
  // Legacy handoffs were journaled while cards lived in a separate table.
  await fixture.rig.drafts()
  await fixture.rig.host.close(SESSION, 'evict')
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
  // Stopped legacy handoffs returned to waiting even if the provider already received them.
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

  // Failed import must leave both storage and the projected card view unchanged.
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
  expect(await fixture.rig.drafts()).toEqual(published)
  const stopped = async () => {
    const { items, submissions } = await fixture.rig.host.journalSnapshot(SESSION)
    return projectStructuredAgentSessionMessages(items, [], submissions).find(
      (entry) => entry.id === agentJournalSubmissionKey('att-stopped')
    )
  }
  const live = fixture.rig.host.collaboratorsForTests().sessions.get(SESSION)!.journal
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

  const deletion = hostTestOperationId()
  expect(await fixture.rig.deleteQueued('ret-present', deletion)).toMatchObject({
    value: { deleted: true }
  })
  const sent = await fixture.rig.sendNow('ret-gone')
  expect(sent).toMatchObject({ ok: true, value: { submission: { queuedMessageId: 'ret-gone' } } })
  // Saved cards are whole values: an import stores each card as it reads, refused or not.
  expect(queueRows()).toEqual([
    'ret-present:queued+refusal',
    'ret-present:withdrawn',
    'ret-gone:queued+refusal',
    'ret-gone:dispatched'
  ])
  expect(legacyIds()).toEqual(all.filter((id) => id !== 'ret-present' && id !== 'ret-gone'))
  await nothingSentTo('edited', 'held')

  // Reopen imports atomically; write refusals only for handoffs absent from this epoch.
  await fixture.rig.restartHostProcess()
  expect(await fixture.rig.drafts()).toEqual(published.slice(2))
  expect(legacyIds()).toEqual(['broken'])
  expect(queueRows().slice(4)).toEqual([
    'cmd-gone:queued+refusal',
    'disp-refused:queued+refusal',
    'stopped-same:queued',
    'stopped-edited:queued',
    'orphan:queued',
    'edited:queued',
    'held:queued'
  ])
  // Unedited stopped cards remain spent on their existing handoff.
  expect(await stopped()).toEqual(displayedStopped)

  // Refused commands become spent once their own turn reports failure.
  const adopted = fixture.rig.host.collaboratorsForTests().sessions.get(SESSION)!.journal
  await adopted.appendItem(
    structuredAgentSessionCommandTurnIdentity('att-cmd'),
    { kind: 'status', text: 'Compact failed' },
    {
      fence: fixture.rig.store.getRecord(SESSION)!.lease.runtimeFence,
      turnScope: AGENT_JOURNAL_THREAD_SCOPE
    }
  )
  expect(await fixture.rig.drafts()).toEqual(published.slice(3))
  expect(await fixture.rig.deleteQueued('disp-refused')).toMatchObject({ value: { deleted: true } })
  await fixture.rig.resume()
  await eventually(async () => expect(await fixture.rig.handoff('edited')).toBeDefined())
  await nothingSentTo('held')
  expect((await fixture.rig.handoff('stopped-edited'))?.clientMessageId).toBe('att-edited')
  expect(await fixture.rig.sendNow('stopped-edited')).toMatchObject({ ok: true })
  const resent = await fixture.rig.handoffId('stopped-edited')
  expect(resent).not.toBe('att-edited')
  await fixture.rig.settleAccepted(resent, 'resent')

  const rows = queueRows()
  await fixture.rig.restartHostProcess()
  await fixture.rig.drafts()
  expect(queueRows()).toEqual(rows)
  expect(await stopped()).toEqual(displayedStopped)
  expect(legacyIds()).toEqual(['broken'])
  expect(await fixture.rig.deleteQueued('ret-present', deletion)).toMatchObject({
    replayed: true,
    value: { deleted: true }
  })

  // Answered-only legacy rows retire without writing new journal rows.
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
