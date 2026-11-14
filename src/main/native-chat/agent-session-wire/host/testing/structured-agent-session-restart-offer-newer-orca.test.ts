import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import {
  codexProviderHandle,
  agentSessionProviderHandleRoot
} from '../../../../../shared/agent-session/lifecycle/agent-session-provider-handle-encoding'
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

it('preserves an unopened newer journal offer without authorizing recovery', async () => {
  const { host, root, acquire } = await interruptedRestart()
  newerOrcaRow(root)
  await keptWithoutAWord(host, root, acquire)
})

it('continues running work on its first demand without optional request metadata', async () => {
  const { host, root, dispatch } = await interruptedRestart()
  const database = openTestJournalHostDatabase(root)
  vi.spyOn(database.history!, 'sourceIdentity').mockReturnValue(null)
  await host.journalSnapshot(SESSION)
  expect((await host.restartResume.continueAfterRestart([SESSION], 'modal')).continued).toEqual([
    SESSION
  ])
  expect(dispatch).toHaveBeenCalledOnce()
})

it.each(['founding', 'superseded-stop'] as const)(
  'holds a damaged %s without blocking a healthy offer, and retries after repair',
  async (damage) => {
    const HEALTHY = 'session-healthy'
    const healthyThread = 'thread-healthy'
    const state = hostTestState()
    const acquire = state.acquire.getMockImplementation()!
    state.acquire.mockImplementation(async (input) => {
      const acquired = await acquire(input)
      return input.identity.sessionId === HEALTHY
        ? {
            ...acquired,
            process: { ...acquired.process, pid: 4243, spawnToken: input.spawnToken },
            link: { ...acquired.link!, handle: codexProviderHandle(healthyThread) }
          }
        : acquired
    })
    const dispatch = state.dispatch.getMockImplementation()!
    state.dispatch.mockImplementation(async (input) => {
      const result = await dispatch(input)
      return input.sessionId === HEALTHY && result.state === 'accepted'
        ? {
            ...result,
            providerIdentity: {
              provider: 'codex',
              threadId: healthyThread,
              turnId: 'healthy-turn',
              ordinal: 1
            }
          }
        : result
    })
    const created = await state.host.attach(
      CALLER,
      attachParams({
        envelope: { ...attachParams().envelope, sessionId: HEALTHY },
        providerHandle: { kind: 'codex', threadId: healthyThread }
      })
    )
    expect(created.ok).toBe(true)
    state.acquire.mockClear()
    const { host, root, marker } = await interruptedRestart()
    const capsule = new AgentSessionRecoveryCapsule(root)
    if (!marker) {
      throw new Error('missing interrupted offer')
    }
    await capsule.record(
      [
        {
          ...marker,
          sessionId: HEALTHY,
          journalCursor: undefined,
          providerHandleRoot: agentSessionProviderHandleRoot(codexProviderHandle(healthyThread))
        }
      ],
      NOW
    )
    const db = openTestJournalHostDatabase(root).db
    let repair: () => void
    if (damage === 'founding') {
      const founding = liveTestJournalRows(db, SESSION)[0]!
      updateTestJournalRowJson(db, SESSION, 1, '}{')
      repair = () => updateTestJournalRowJson(db, SESSION, 1, founding.rowJson)
    } else {
      const source = db
        .prepare('SELECT generation, through_seq FROM journal_outcome_epochs WHERE session_id = ?')
        .get(SESSION)!
      const generation = Number(source.generation)
      const sequence = Number(source.through_seq) - 1
      const prior = db
        .prepare(
          `SELECT value_json FROM journal_outcomes WHERE generation = ? AND seq = ? AND field = '$' AND entry_key = '"queuePauseMarks"'`
        )
        .get(generation, sequence)
      db.prepare(`INSERT OR REPLACE INTO journal_outcomes (generation, seq, field, entry_key, format, ordinal, value_json, deleted)
      VALUES (?, ?, '$', '"queuePauseMarks"', 3, '', '{', 0)`).run(generation, sequence)
      repair = () => {
        if (prior) {
          db.prepare(
            `UPDATE journal_outcomes SET value_json = ? WHERE generation = ? AND seq = ? AND field = '$' AND entry_key = '"queuePauseMarks"'`
          ).run(prior.value_json, generation, sequence)
        } else {
          db.prepare(
            `DELETE FROM journal_outcomes WHERE generation = ? AND seq = ? AND field = '$' AND entry_key = '"queuePauseMarks"'`
          ).run(generation, sequence)
        }
      }
    }

    expect((await host.restartResume.list()).map((candidate) => candidate.sessionId)).toEqual([
      HEALTHY
    ])
    const result = await host.restartResume.continueAfterRestart(undefined, 'startup')
    expect(result.continued).toMatchObject([{ sessionId: HEALTHY, outcome: 'continued' }])
    expect(await host.restartResume.listFailures()).toEqual([])
    expect((await capsule.list(NOW)).map((offer) => offer.sessionId)).toEqual([SESSION])
    repair()
    expect(
      (await host.restartResume.continueAfterRestart([SESSION], 'modal')).continued
    ).toMatchObject([{ sessionId: SESSION, outcome: 'continued' }])
  }
)

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
        SESSION
      ])
    }
    await host.restartResume.dismiss(undefined, audience)

    const left = await new AgentSessionRecoveryCapsule(root).list(NOW)
    expect(left.map((offer) => offer.sessionId)).toEqual([NEWER])
    expect(await newerEntry()).toBe(before)
  }
)
