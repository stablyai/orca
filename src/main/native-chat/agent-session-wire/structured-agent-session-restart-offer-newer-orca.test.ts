import { mutateTestJournalFixture } from '../agent-session-journal/journal-drained-fixture-test-support'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import {
  AGENT_SESSION_RECOVERY_CAPSULE_FILE,
  AgentSessionRecoveryCapsule
} from '../../runtime/agent-session/records/agent-session-recovery-capsule'
import {
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

// Preserve newer-chat offers byte-for-byte for a compatible build; this host cannot act on them.

afterEach(() => vi.restoreAllMocks())

async function newerOrcaRow(root: string, sessionId: string = SESSION): Promise<void> {
  const database = await openTestJournalHostDatabase(root)
  const first = (await liveTestJournalRows(database, sessionId))[0]
  if (!first) {
    throw new Error('the chat has no founding row')
  }
  const anchor = JSON.parse(first.rowJson)
  await mutateTestJournalFixture(database, (db) => {
    db.prepare('UPDATE journal_outcome_epochs SET format = 99 WHERE session_id = ?').run(sessionId)
  })
  await updateTestJournalRowJson(
    database,
    sessionId,
    1,
    JSON.stringify({ ...anchor, v: 99, outcomeFormat: 99 })
  )
}

function offersFile(root: string): Promise<Buffer> {
  return readFile(join(root, AGENT_SESSION_RECOVERY_CAPSULE_FILE))
}

async function keptWithoutAWord(
  host: Awaited<ReturnType<typeof interruptedRestart>>['host'],
  root: string,
  acquire: ReturnType<typeof vi.fn>,
  unopenedJournalIsNewer = false
) {
  const before = await offersFile(root)
  expect((await host.restartResume.list()).map((offer) => offer.sessionId)).toEqual(
    unopenedJournalIsNewer ? [SESSION] : []
  )
  expect(await offersFile(root)).toEqual(before)
  expect((await host.restartResume.continueAfterRestart([SESSION], 'modal')).continued).toEqual([])
  expect(acquire).not.toHaveBeenCalled()
  expect(await host.restartResume.listFailures()).toEqual([])
  expect(await offersFile(root)).toEqual(before)
  const capsule = new AgentSessionRecoveryCapsule(root)
  expect((await capsule.list(NOW)).map((marker) => marker.sessionId)).toEqual([SESSION])
  expect(await capsule.listFailed(NOW)).toEqual([])
}

it('lists an unopened newer journal passively and preserves its offer when acting is refused', async () => {
  const { host, root, acquire } = await interruptedRestart()
  await newerOrcaRow(root)
  await keptWithoutAWord(host, root, acquire, true)
})

it('keeps the offer of every chat in a newer Orca database, and offers, runs and counts nothing', async () => {
  const { host, root, acquire } = await interruptedRestart()
  const database = await openTestJournalHostDatabase(root)
  await mutateTestJournalFixture(database, (db) => {
    db.exec('ALTER TABLE journal_sessions RENAME TO journal_sessions_newer')
  })
  Object.defineProperty(database, 'readOnly', { value: true })
  await keptWithoutAWord(host, root, acquire)
})

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

it('lists a filed failure passively and hides it once an action discovers a newer journal', async () => {
  const { host, root, acquire } = await interruptedRestart()
  await host.restartResume.list()
  acquire.mockRejectedValueOnce(new Error('provider could not reconnect'))
  await host.restartResume.continueAfterRestart([SESSION], 'modal')
  expect(await host.restartResume.listFailures()).toMatchObject([{ sessionId: SESSION }])
  await host.close(SESSION, 'evict')
  await newerOrcaRow(root)

  expect(await host.restartResume.listFailures()).toMatchObject([{ sessionId: SESSION }])
  await host.restartResume.continueAfterRestart([SESSION], 'retry')
  expect(await host.restartResume.listFailures()).toEqual([])
  expect(
    (await new AgentSessionRecoveryCapsule(root).listFailed(NOW)).map((f) => f.marker.sessionId)
  ).toEqual([SESSION])
})

it('still offers a damaged chat, and files its failure when acting on it', async () => {
  const { host, root, acquire } = await interruptedRestart()
  updateTestJournalRowJson(await openTestJournalHostDatabase(root), SESSION, 1, '}{')

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

it.each([
  ['after the dialog listed the offers', true, undefined],
  ['on a host that has not listed them yet', false, undefined],
  ['for a client shown only Codex', false, (agent: string) => agent === 'codex']
])(
  "dismisses every listed offer and leaves a newer Orca's hidden one as it was, %s",
  async (_when, listFirst, audience) => {
    const NEWER = 'session-newer-orca'
    const created = await hostTestState().host.attach(
      CALLER,
      attachParams({ envelope: { ...attachParams().envelope, sessionId: NEWER } })
    )
    expect(created.ok).toBe(true)
    hostTestState().acquire.mockClear()
    const { host, root, marker } = await interruptedRestart()
    await newerOrcaRow(root, NEWER)
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
        SESSION,
        NEWER
      ])
    }
    await host.restartResume.dismiss(undefined, audience)

    const left = await new AgentSessionRecoveryCapsule(root).list(NOW)
    expect(left.map((offer) => offer.sessionId)).toEqual([NEWER])
    expect(await newerEntry()).toBe(before)
  }
)
