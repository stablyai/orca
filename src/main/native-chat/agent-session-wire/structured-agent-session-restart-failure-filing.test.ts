import { openTestJournalHostDatabase } from '../agent-session-journal/journal-host-database-test-support'
import { openTestAgentSessionRecordStore } from '../../runtime/agent-session-record-store-test-harness'
import { StructuredAgentSessionHost } from './structured-agent-session-host'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentSessionRecoveryCapsule } from '../../runtime/agent-session-recovery-capsule'
import {
  AGENT_SESSION_RESTART_CONTINUATION_NOTE,
  AGENT_SESSION_RESTART_CONTINUATION_REFUSED_NOTE,
  AGENT_SESSION_RESTART_CONTINUATION_UNCONFIRMED_NOTE
} from '../../../shared/agent-session-restart-continuation'
import { StructuredAgentSessionResumeAdmission } from './structured-agent-session-restart-resume-runner'
import {
  interruptedRestart,
  QUIT_CUT_NOTICE,
  readerNotes,
  statusNotes,
  continuationCannotFold
} from './structured-agent-session-restart-interruption-test-harness'
import { CALLER, envelope } from './structured-agent-session-host-test-harness'
import {
  HOST_TEST_NOW as NOW,
  HOST_TEST_SESSION as SESSION,
  hostTestMessage
} from './structured-agent-session-host-test-data'

afterEach(() => vi.restoreAllMocks())

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

// Successful continuation notes follow their own message; preserve the earlier cut notice.
it("keeps the quit's notice through a continuation that carries the chat on", async () => {
  const { host } = await interruptedRestart()
  await host.restartResume.list()
  expect(await readerNotes(host)).toEqual([QUIT_CUT_NOTICE])

  const result = await host.restartResume.continueAfterRestart([SESSION], 'modal')

  expect(result.continued).toMatchObject([{ outcome: 'continued' }])
  expect(await readerNotes(host)).toEqual([
    QUIT_CUT_NOTICE,
    { text: AGENT_SESSION_RESTART_CONTINUATION_NOTE, tone: undefined }
  ])
})

it('keeps an unconfirmed failure while the agent the continuation started keeps running', async () => {
  const { host } = await interruptedRestart()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  await host.restartResume.list()
  continuationCannotFold()

  const result = await host.restartResume.continueAfterRestart([SESSION], 'modal')

  expect(result.failed).toMatchObject([{ sessionId: SESSION, outcome: 'unconfirmed' }])
  expect(await statusNotes(host)).toContainEqual({
    text: AGENT_SESSION_RESTART_CONTINUATION_UNCONFIRMED_NOTE,
    tone: 'warning'
  })
  expect(await host.restartResume.listFailures()).toMatchObject([{ outcome: 'unconfirmed' }])
})
