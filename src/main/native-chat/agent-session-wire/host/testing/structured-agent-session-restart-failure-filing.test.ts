import { openTestJournalHostDatabase } from '../../../agent-session-journal/store-lifecycle/journal-host-database-test-support'
import { openTestAgentSessionRecordStore } from '../../../../runtime/agent-session/records/agent-session-record-store-test-harness'
import { StructuredAgentSessionHost } from '../structured-agent-session-host'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentSessionRecoveryCapsule } from '../../../../runtime/agent-session/records/agent-session-recovery-capsule'
import { AGENT_SESSION_RESTART_CONTINUATION_REFUSED_NOTE } from '../../../../../shared/agent-session/lifecycle/agent-session-restart-continuation'
import { StructuredAgentSessionResumeAdmission } from '../../recovery/structured-agent-session-restart-resume-runner'
import {
  interruptedRestart,
  QUIT_CUT_NOTICE,
  readerNotes,
  statusNotes
} from './structured-agent-session-restart-interruption-test-harness'
import { CALLER, envelope } from './structured-agent-session-host-test-harness'
import {
  HOST_TEST_NOW as NOW,
  HOST_TEST_SESSION as SESSION,
  hostTestMessage
} from './structured-agent-session-host-test-data'

afterEach(() => vi.restoreAllMocks())

it('replays accepted restart work after a post-commit capsule failure without filing a refusal', async () => {
  const { host, root, dispatch } = await interruptedRestart()
  const accept = AgentSessionRecoveryCapsule.prototype.withSelectedResume
  vi.spyOn(AgentSessionRecoveryCapsule.prototype, 'withSelectedResume').mockImplementationOnce(
    async function (this: AgentSessionRecoveryCapsule, ...args) {
      await accept.apply(this, args)
      throw new Error('capsule release failed after acceptance')
    }
  )
  const result = await host.restartResume.continueAfterRestart([SESSION], 'modal')
  expect(result.failed).toEqual([])
  expect((await host.journalSnapshot(SESSION)).submissions).toHaveLength(1)
  expect(await new AgentSessionRecoveryCapsule(root).listFailed(NOW)).toEqual([])
  await host.restartResume.continueAfterRestart([SESSION], 'modal')
  expect(dispatch).toHaveBeenCalledOnce()
  expect((await host.journalSnapshot(SESSION)).submissions).toHaveLength(1)
})

it('keeps an accepted restart offer when its settlement cannot establish Stop history', async () => {
  const { host, root, store, dispatch } = await interruptedRestart()
  const database = openTestJournalHostDatabase(root)
  const settle = AgentSessionRecoveryCapsule.prototype.settleResume
  let retained: string[] | undefined
  let failures: unknown
  let historyUnavailable = false
  vi.spyOn(AgentSessionRecoveryCapsule.prototype, 'settleResume').mockImplementationOnce(
    async function (this: AgentSessionRecoveryCapsule, ...args) {
      // A historical correction after admission requires fresh retirement evidence.
      database.db
        .prepare('UPDATE journal_rows SET row_json = row_json WHERE session_id = ? AND seq = 1')
        .run(SESSION)
      const prepare = database.db.prepare.bind(database.db)
      let failed = false
      const reading = vi.spyOn(database.db, 'prepare').mockImplementation((sql) => {
        if (!failed && sql.includes('seq >= ? AND seq <= ?') && sql.includes('stopEvent')) {
          failed = true
          historyUnavailable = true
          throw new Error('retirement history temporarily unavailable')
        }
        return prepare(sql)
      })
      try {
        const result = await settle.apply(this, args)
        const capsule = new AgentSessionRecoveryCapsule(root)
        retained = (await capsule.list(NOW)).map((offer) => offer.sessionId)
        failures = await capsule.listFailed(NOW)
        return result
      } finally {
        reading.mockRestore()
      }
    }
  )

  await host.restartResume.continueAfterRestart([SESSION], 'modal')
  expect(historyUnavailable).toBe(true)
  expect(retained).toEqual([SESSION])
  expect(failures).toEqual([])
  const submissions = (await host.journalSnapshot(SESSION)).submissions
  expect(submissions).toHaveLength(1)
  expect(
    store.readCommandReceipt({ kind: 'global' }, submissions[0]!.clientMessageId)
  ).toMatchObject({
    verdict: 'readable'
  })
  await host.restartResume.continueAfterRestart([SESSION], 'modal')
  expect(dispatch).toHaveBeenCalledOnce()
  expect(await host.restartResume.list()).toEqual([])
})

it('files nothing for a chat the user moved on in before its attempt, and spends the offer', async () => {
  const { host, root, dispatch } = await interruptedRestart()
  await host.restartResume.list()
  const admit = StructuredAgentSessionResumeAdmission.prototype.run
  vi.spyOn(StructuredAgentSessionResumeAdmission.prototype, 'run').mockImplementationOnce(
    async function (this, ...args) {
      const body = hostTestMessage('A newer task from another client')
      await host.send(CALLER, { envelope: envelope('agentSession.send', { body }), body })
      return admit.apply(this, args)
    }
  )

  const result = await host.restartResume.continueAfterRestart([SESSION], 'modal')

  expect(result.continued.filter((entry) => entry.outcome === 'continued')).toEqual([])
  expect(result.failed).toEqual([])
  await vi.waitFor(() => expect(dispatch).toHaveBeenCalledOnce())
  const capsule = new AgentSessionRecoveryCapsule(root)
  expect(await capsule.listFailed(NOW)).toEqual([])
  expect(await capsule.list(NOW)).toEqual([])
  expect(await statusNotes(host)).toEqual([QUIT_CUT_NOTICE])
  expect(await readerNotes(host)).toEqual([QUIT_CUT_NOTICE])
})

it('says so in the chat when the agent cannot start for the continuation', async () => {
  const { host, acquire, root } = await interruptedRestart()
  await host.restartResume.list()
  acquire.mockRejectedValueOnce(new Error('provider could not reconnect'))
  expect(await readerNotes(host)).toEqual([QUIT_CUT_NOTICE])

  await host.restartResume.continueAfterRestart([SESSION], 'modal')

  expect(await host.restartResume.listFailures()).toMatchObject([
    { sessionId: SESSION, outcome: 'refused', retryable: true }
  ])
  expect(await statusNotes(host)).toContainEqual({
    text: AGENT_SESSION_RESTART_CONTINUATION_REFUSED_NOTE,
    tone: 'error'
  })
  // The failure note replaces the derived cut notice to avoid duplicate explanations.
  expect(await readerNotes(host)).toEqual(await statusNotes(host))
  await host.flushAllStreamedEvents()
  openTestJournalHostDatabase(root)
    .db.prepare(
      "UPDATE agent_session_records SET record_json = json_set(record_json, '$.lease.minimumNextFence', 'bad') WHERE session_id = ?"
    )
    .run(SESSION)
  const store = await openTestAgentSessionRecordStore(root)
  const restarted = new StructuredAgentSessionHost({ ...host.deps, store })
  const starts = acquire.mock.calls.length
  expect(await restarted.restartResume.listFailures()).toMatchObject([
    { sessionId: SESSION, outcome: 'refused', retryable: false }
  ])
  expect(await restarted.restartResume.list()).toEqual([])
  expect(acquire).toHaveBeenCalledTimes(starts)
  await restarted.flushAllStreamedEvents()
})

it.each(['stop', 'hide'] as const)(
  'keeps a queued restart cancelled after personal %s even when capsule cleanup fails',
  async (action) => {
    const { host, root } = await interruptedRestart()
    await host.showSessionTabs([SESSION])
    const run = StructuredAgentSessionResumeAdmission.prototype.run
    vi.spyOn(StructuredAgentSessionResumeAdmission.prototype, 'run').mockImplementationOnce(
      function (
        this: StructuredAgentSessionResumeAdmission,
        sessionId,
        owner,
        task,
        onPhase,
        prepare
      ) {
        return run.call(
          this,
          sessionId,
          owner,
          async () => {
            if (action === 'stop') {
              expect(
                await host.cancel(CALLER, { envelope: envelope('agentSession.cancel', {}) })
              ).toMatchObject({ ok: true, value: { cancelled: true } })
            } else {
              await host.setSessionTabVisibility(SESSION, false)
            }
            return task()
          },
          onPhase,
          prepare
        )
      }
    )
    vi.spyOn(AgentSessionRecoveryCapsule.prototype, 'forgetWitnesses').mockRejectedValue(
      new Error('cleanup unavailable')
    )
    vi.spyOn(AgentSessionRecoveryCapsule.prototype, 'dismiss').mockRejectedValue(
      new Error('cleanup unavailable')
    )
    const resumed = await host.restartResume.continueAfterRestart([SESSION], 'auto')
    expect(resumed.continued).toEqual([])
    expect(resumed.failed).toEqual([])
    expect((await host.journalSnapshot(SESSION)).submissions).toEqual([])
    expect(await host.restartResume.list()).toEqual([])
    // Personal cancellation remains authoritative even when another host stop is the latest event.
    const journal = host.collaboratorsForTests().sessions.get(SESSION)!.journal
    await journal.appendStopEvent(
      { reason: 'host-stop' },
      host.deps.store.getConversation(SESSION)!.currentFence
    )
    const stored = await openTestAgentSessionRecordStore(root)
    const next = new StructuredAgentSessionHost({ ...host.deps, store: stored })
    expect(await next.restartResume.list()).toEqual([])
    expect((await next.restartResume.continueAfterRestart([SESSION], 'auto')).failed).toEqual([])
    await next.flushAllStreamedEvents()
  }
)
