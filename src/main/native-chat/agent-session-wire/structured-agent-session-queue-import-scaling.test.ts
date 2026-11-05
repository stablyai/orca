import { setTestJournalTrigger } from '../agent-session-journal/journal-native-fixture-test-support'
import { expect, it, vi } from 'vitest'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentSessionSubscribeEvent } from '../../../shared/agent-session/agent-session-wire'
import { AgentSessionSubscribers } from './structured-agent-session-subscribers'
import { HOST_TEST_SESSION as SESSION } from './structured-agent-session-host-test-data'

import {
  fixture,
  threadWrite,
  type Legacy,
  db,
  handOff,
  journalFor,
  legacyIds,
  message,
  seedLegacy
} from './structured-agent-session-queue-import-contract-test-fixture'

it.each([100, 1_000].flatMap((size) => [false, true].map((adopt) => ({ size, adopt }))))(
  'publication reuse: $size historical items, adopted=$adopt',
  async ({ size, adopt }) => {
    const corrections = 1
    const earlier = await journalFor(SESSION)
    await earlier.open()
    await handOff(
      earlier,
      'u-0',
      'q-0',
      'stopped words',
      'cancelled',
      0,
      async () => {
        await earlier.appendLifecycleBatch({
          settlementId: 'seed-publication-history',
          fence: 0,
          mutations: Array.from({ length: size }, (_, ordinal) => ({
            kind: 'item' as const,
            identity: { provider: 'codex' as const, threadId: 'history', turnId: 't', ordinal },
            body: { ...message('old answer'), role: 'assistant' as const },
            turnScope: AGENT_JOURNAL_THREAD_SCOPE
          }))
        })
      },
      { turn: { provider: 'codex', threadId: 'history', turnId: 't', ordinal: -1 }, via: 'steer' }
    )
    await earlier.close()
    await seedLegacy(
      SESSION,
      Array.from({ length: corrections }, (_, i): Legacy => [`q-${i}`, 'waiting', 'stopped words'])
    )
    if (!adopt) {
      await setTestJournalTrigger(await db(), {
        name: 'b2_perf_fail_import',
        event: 'DELETE',
        table: 'queued_messages',
        message: 'disk full'
      })
    }
    const journal = await journalFor(SESSION)
    await journal.open()
    expect(await legacyIds()).toHaveLength(adopt ? 0 : corrections)
    const feed = new AgentSessionSubscribers()
    const events: AgentSessionSubscribeEvent[] = []
    try {
      for (const id of ['desktop', 'phone', 'old']) {
        feed.open({
          sessionId: SESSION,
          journal,
          fence: 0,
          id,
          boundedFrames: id === 'phone',
          cursor: journal.cursor(),
          snapshotCatchUp: id !== 'old',
          readsCurrentRequests: id !== 'old',
          emit: (event) => events.push(event)
        })
      }
      await vi.waitFor(() => expect(events).toHaveLength(3))
      expect(events.filter((event) => event.type === 'snapshot')).toHaveLength(2)
      const original = journal.snapshot().items.find((item) => item.itemId === 'orca:u-0')
      expect(original?.body).toEqual(message('stopped words'))
      for (let publication = 0; publication < 10; publication++) {
        const from = events.length
        const body = { ...message(`progress-${publication}`), role: 'assistant' as const }
        await journal.appendItem(
          { provider: 'codex', threadId: 'progress', turnId: 't', ordinal: publication },
          body,
          { fence: 0, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
        )
        feed.publish(SESSION, journal)
        await vi.waitFor(() => expect(events.slice(from)).toHaveLength(3))
        for (const event of events.slice(from)) {
          expect(event).toMatchObject({
            type: 'batch',
            batch: { items: [{ body }], removedItemIds: [] }
          })
        }
        expect(journal.snapshot().items.find((item) => item.itemId === 'orca:u-0')).toEqual(
          original
        )
        expect(journal.submission('u-0')).toMatchObject({ dispatchState: 'unknown' })
      }
      expect(events.filter((event) => event.type === 'snapshot')).toHaveLength(2)
      await journal.close()
      const reopened = await journalFor(SESSION)
      await reopened.open()
      expect(reopened.snapshot().items).toHaveLength(size + corrections + 10)
      expect(reopened.snapshot().items.find((item) => item.itemId === 'orca:u-0')).toEqual(original)
      await reopened.close()
    } finally {
      for (const id of ['desktop', 'phone', 'old']) {
        feed.close(SESSION, id)
      }
      if (!adopt) {
        await setTestJournalTrigger(await db(), { remove: 'b2_perf_fail_import' })
      }
    }
    await journal.close()
  }
)

it.each([10, 100])('preserves failed-import queue order, edits and withdrawals N=%i', async (n) => {
  const session = 'overlay-scale'
  const seed = await journalFor(session)
  await seed.open()
  await seed.queuedMessages.insert({ messageId: 'C', body: message('/compact') })
  await seed.close()
  await seedLegacy(
    session,
    Array.from({ length: n }, (_, i): Legacy => [`D${i}`, 'waiting', `body${i}`])
  )
  await setTestJournalTrigger(await db(), {
    name: 'overlay_scale_import_failure',
    event: 'DELETE',
    table: 'queued_messages',
    message: 'import failure'
  })
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const journal = await journalFor(session)
  try {
    await journal.open()
    for (let i = 0; i < n; i++) {
      journal.publicRead()
      expect(journal.queuedMessages.nextInputCard()?.messageId).toBe('C')
    }
    await journal.appendItem(
      { provider: 'orca', clientMessageId: 'unrelated' },
      message('unrelated'),
      threadWrite
    )
    for (let i = 0; i < n; i++) {
      await journal.appendSubmission({
        clientMessageId: `M${i}`,
        body: message(`M${i}`),
        payloadFingerprint: `M${i}`,
        origin: 'client',
        handoverRecorded: true,
        fence: 0
      })
      expect(journal.inputOrder.forced(`M${i}`)).toBe(true)
      expect(
        journal.inputOrder.precedes(
          journal.queuedMessages.get(`D${n - 1}`)!,
          journal.submission(`M${i}`)!
        )
      ).toBe(true)
    }
    await setTestJournalTrigger(await db(), { remove: 'overlay_scale_import_failure' })
    const old = journal.queuedMessages.get('D0')!
    expect(
      await journal.queuedMessages.update({
        messageId: 'D0',
        expectedBodyFingerprint: old.fingerprint,
        text: 'latest D'
      })
    ).toMatchObject({ status: 'updated' })
    expect(journal.queuedMessages.get('D0')?.body).toEqual(message('latest D'))
    await journal.queuedMessages.withdraw(Array.from({ length: n }, (_, i) => `D${i}`))
    expect(journal.queuedMessages.list().map((row) => row.messageId)).toEqual(['C'])
    expect(await legacyIds(session)).toEqual([])
    expect(fixture.rig.dispatch).not.toHaveBeenCalled()
  } finally {
    await setTestJournalTrigger(await db(), { remove: 'overlay_scale_import_failure' })
    warn.mockRestore()
    await journal.close()
  }
})
