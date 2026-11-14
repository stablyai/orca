import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import {
  AGENT_SESSION_RECOVERY_CAPSULE_FILE,
  AgentSessionRecoveryCapsule
} from '../../../../runtime/agent-session/records/agent-session-recovery-capsule'
import {
  liveTestJournalRows,
  openTestJournalHostDatabase,
  updateTestJournalRowJson
} from '../../../agent-session-journal/store-lifecycle/journal-host-database-test-support'

import { interruptedRestart } from './structured-agent-session-restart-interruption-test-harness'
import { attachParams, CALLER, hostTestState } from './structured-agent-session-host-test-harness'
import {
  HOST_TEST_NOW as NOW,
  HOST_TEST_SESSION as SESSION
} from './structured-agent-session-host-test-data'

// Preserve newer-chat offers byte-for-byte for a compatible build; this host cannot act on them.

afterEach(() => vi.restoreAllMocks())

function newerOrcaRow(root: string, sessionId: string = SESSION): void {
  const { db } = openTestJournalHostDatabase(root)
  const first = liveTestJournalRows(db, sessionId)[0]
  if (!first) {
    throw new Error('the chat has no founding row')
  }
  const anchor = JSON.parse(first.rowJson)
  db.prepare('UPDATE journal_outcome_epochs SET format = 99 WHERE session_id = ?').run(sessionId)
  updateTestJournalRowJson(
    db,
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
  newerOrcaRow(root)
  await keptWithoutAWord(host, root, acquire, true)
})

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
