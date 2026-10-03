import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import {
  AGENT_SESSION_RECOVERY_CAPSULE_FILE,
  AgentSessionRecoveryCapsule
} from '../../runtime/agent-session-recovery-capsule'
import { AGENT_SESSION_JOURNAL_SCHEMA_VERSION } from '../../../shared/agent-session-journal-types'
import {
  insertTestJournalRowJson,
  liveTestJournalRows,
  openTestJournalHostDatabase,
  updateTestJournalRowJson
} from '../agent-session-journal/journal-host-database-test-support'
import { AgentSessionJournal } from '../agent-session-journal/journal-store'
import { AgentSessionJournalError } from '../agent-session-journal/journal-write-guards'
import { interruptedRestart } from './structured-agent-session-restart-interruption-test-harness'
import { attachParams, CALLER, hostTestState } from './structured-agent-session-host-test-harness'
import {
  HOST_TEST_NOW as NOW,
  HOST_TEST_SESSION as SESSION
} from './structured-agent-session-host-test-data'

// Nothing here can continue a chat a newer Orca saved, so it is not offered after a restart and
// nothing is counted. Its offer is kept: the offers file is shared by every Orca on the host, and
// the newer one can still act on it. Nothing here writes to that file for such a chat.

afterEach(() => vi.restoreAllMocks())

/** Writes a row of a kind this build does not know into the chat's journal, as a newer Orca would. */
function newerOrcaRow(root: string, sessionId: string = SESSION): void {
  const { db } = openTestJournalHostDatabase(root)
  const last = liveTestJournalRows(db, sessionId).at(-1)
  const parsed: unknown = last ? JSON.parse(last.rowJson) : null
  if (!last || typeof parsed !== 'object' || parsed === null || !('epoch' in parsed)) {
    throw new Error('the chat has no journal row to follow')
  }
  const { epoch } = parsed
  const seq = last.seq + 1
  insertTestJournalRowJson(
    db,
    sessionId,
    seq,
    JSON.stringify({
      v: AGENT_SESSION_JOURNAL_SCHEMA_VERSION,
      kind: 'future-mark',
      epoch,
      seq,
      fence: 1,
      ts: NOW
    }),
    NOW
  )
}

function offersFile(root: string): Promise<Buffer> {
  return readFile(join(root, AGENT_SESSION_RECOVERY_CAPSULE_FILE))
}

/** Lists and acts with nothing offered, run or counted, and the offers file left byte-identical. */
async function keptWithoutAWord(
  host: Awaited<ReturnType<typeof interruptedRestart>>['host'],
  root: string,
  acquire: ReturnType<typeof vi.fn>
) {
  const before = await offersFile(root)
  expect(await host.restartResume.list()).toEqual([])
  expect(await offersFile(root)).toEqual(before)
  expect((await host.restartResume.continueAfterRestart([SESSION], 'modal')).continued).toEqual([])
  expect(acquire).not.toHaveBeenCalled()
  expect(await host.restartResume.listFailures()).toEqual([])
  expect(await offersFile(root)).toEqual(before)
  const capsule = new AgentSessionRecoveryCapsule(root)
  expect((await capsule.list(NOW)).map((marker) => marker.sessionId)).toEqual([SESSION])
  expect(await capsule.listFailed(NOW)).toEqual([])
}

it('keeps the offer of a chat whose journal a newer Orca wrote, and offers, runs and counts nothing', async () => {
  const { host, root, acquire } = await interruptedRestart()
  newerOrcaRow(root)
  await keptWithoutAWord(host, root, acquire)
})

// A newer Orca's whole database: every chat in it is a newer Orca's, even one whose tables changed.
it('keeps the offer of every chat in a newer Orca database, and offers, runs and counts nothing', async () => {
  const { host, root, acquire } = await interruptedRestart()
  const database = openTestJournalHostDatabase(root)
  Object.defineProperty(database, 'readOnly', { value: true })
  database.db.exec('ALTER TABLE journal_sessions RENAME TO journal_sessions_newer')
  await keptWithoutAWord(host, root, acquire)
})

// However a newer Orca's refusal reaches a send (a journal first opened when sending), it files
// nothing and the offer is reopened.
it('keeps the offer and files nothing when the send is refused as a newer Orca chat', async () => {
  const { host, root } = await interruptedRestart()
  await host.restartResume.list()
  vi.spyOn(AgentSessionJournal.prototype, 'appendSubmission').mockRejectedValue(
    new AgentSessionJournalError('journal_read_only', 'a newer Orca wrote this journal')
  )

  const action = await host.restartResume.continueAfterRestart([SESSION], 'modal')

  expect(action.continued).toMatchObject([
    {
      outcome: 'refused',
      reason: 'agent_session_journal_unreadable',
      refusal: { details: { reason: 'journalWrittenByNewerOrca' } }
    }
  ])
  const capsule = new AgentSessionRecoveryCapsule(root)
  expect(await capsule.listFailed(NOW)).toEqual([])
  expect((await capsule.list(NOW)).map((marker) => marker.sessionId)).toEqual([SESSION])
  expect(await host.restartResume.listFailures()).toEqual([])
})

// A failure filed before the chat became a newer Orca's stays for that Orca, and is not shown here.
it('keeps a failure already filed for a chat a newer Orca saved since, but does not show it', async () => {
  const { host, root, acquire } = await interruptedRestart()
  await host.restartResume.list()
  acquire.mockRejectedValueOnce(new Error('provider could not reconnect'))
  await host.restartResume.continueAfterRestart([SESSION], 'modal')
  expect(await host.restartResume.listFailures()).toMatchObject([{ sessionId: SESSION }])
  await host.close(SESSION, 'evict')
  newerOrcaRow(root)

  expect(await host.restartResume.listFailures()).toEqual([])
  expect(
    (await new AgentSessionRecoveryCapsule(root).listFailed(NOW)).map((f) => f.marker.sessionId)
  ).toEqual([SESSION])
})

// What listing does with a journal that throws for another reason: a damaged chat stays offered,
// and acting on it files the failure, which names the damage.
it('still offers a damaged chat, and files its failure when acting on it', async () => {
  const { host, root, acquire } = await interruptedRestart()
  updateTestJournalRowJson(openTestJournalHostDatabase(root).db, SESSION, 1, '}{')

  expect((await host.restartResume.list()).map((candidate) => candidate.sessionId)).toEqual([
    SESSION
  ])
  await host.restartResume.continueAfterRestart([SESSION], 'modal')

  expect(acquire).not.toHaveBeenCalled()
  expect(await host.restartResume.listFailures()).toMatchObject([
    {
      sessionId: SESSION,
      reason: 'agent_session_journal_unreadable',
      details: { reason: 'journalCorrupt' }
    }
  ])
})

// "Dismiss all" ends what the person was shown. A newer Orca's offer was never shown here, so it
// stays, byte for byte, for the Orca that can act on it.
it.each([
  ['after the dialog listed the offers', true],
  ['on a host that has not listed them yet', false]
])(
  "dismisses every listed offer and leaves a newer Orca's hidden one as it was, %s",
  async (_when, listFirst) => {
    const NEWER = 'session-newer-orca'
    // A second chat, made before the restart; a newer Orca then saves it with a row this build
    // can't place.
    const created = await hostTestState().host.attach(
      CALLER,
      attachParams({ envelope: { ...attachParams().envelope, sessionId: NEWER } })
    )
    expect(created.ok).toBe(true)
    hostTestState().acquire.mockClear()
    const { host, root, marker } = await interruptedRestart()
    newerOrcaRow(root, NEWER)
    const path = join(root, AGENT_SESSION_RECOVERY_CAPSULE_FILE)
    const capsule = JSON.parse(await readFile(path, 'utf8'))
    capsule.entries.push({ state: 'pending', marker: { ...marker, sessionId: NEWER } })
    await writeFile(path, JSON.stringify(capsule))
    const newerEntry = () =>
      readFile(path, 'utf8').then((text) =>
        JSON.stringify(
          JSON.parse(text).entries.find(
            (entry: { marker: { sessionId: string } }) => entry.marker.sessionId === NEWER
          )
        )
      )
    const before = await newerEntry()

    if (listFirst) {
      expect((await host.restartResume.list()).map((candidate) => candidate.sessionId)).toEqual([
        SESSION
      ])
    }
    await host.restartResume.dismiss()

    const left = await new AgentSessionRecoveryCapsule(root).list(NOW)
    expect(left.map((offer) => offer.sessionId)).toEqual([NEWER])
    expect(await newerEntry()).toBe(before)
  }
)
