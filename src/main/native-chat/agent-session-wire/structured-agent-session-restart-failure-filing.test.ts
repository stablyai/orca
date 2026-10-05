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
  throwAfterContinuationAccepted
} from './structured-agent-session-restart-interruption-test-harness'
import { CALLER, envelope } from './structured-agent-session-host-test-harness'
import {
  HOST_TEST_NOW as NOW,
  HOST_TEST_SESSION as SESSION,
  hostTestMessage
} from './structured-agent-session-host-test-data'

// Which outcomes of a restart action become a failure the user is shown, and what retires one.

afterEach(() => vi.restoreAllMocks())

// Nothing was owed once the user's own message came first: the offer is spent and nothing is filed.
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
  expect(await statusNotes(host)).toEqual([])
  // No note took over, so the cut turn keeps its one notice.
  expect(await readerNotes(host)).toEqual([QUIT_CUT_NOTICE])
})

// The continuation is accepted and its agent then fails to start: the message is rejected with the
// cause, the failure is filed, and the chat says the agent did not carry on.
it('says so in the chat when the agent cannot start for the continuation', async () => {
  const { host, acquire } = await interruptedRestart()
  await host.restartResume.list()
  acquire.mockRejectedValueOnce(new Error('provider could not reconnect'))
  // Before the action, the quit's cut reads with its one notice.
  expect(await readerNotes(host)).toEqual([QUIT_CUT_NOTICE])

  await host.restartResume.continueAfterRestart([SESSION], 'modal')

  expect(await host.restartResume.listFailures()).toMatchObject([
    { sessionId: SESSION, outcome: 'refused', retryable: true }
  ])
  expect(await statusNotes(host)).toContainEqual({
    text: AGENT_SESSION_RESTART_CONTINUATION_REFUSED_NOTE,
    tone: 'error'
  })
  // The refusal note is now the one explanation: the cut is not said a second time beside it.
  expect(await readerNotes(host)).toEqual(await statusNotes(host))
})

// A continuation that carries on, chosen in the prompt or automatically at launch, does not stand in
// for the cut: its note is written after its own message, so the cut keeps its notice throughout.
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

// A send that throws after Orca may have taken it cannot be proven undelivered: filed unconfirmed,
// and it stays on record while the agent that may be carrying on keeps running.
it('keeps an unconfirmed failure while the agent the continuation started keeps running', async () => {
  const { host } = await interruptedRestart()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  await host.restartResume.list()
  throwAfterContinuationAccepted()

  const result = await host.restartResume.continueAfterRestart([SESSION], 'modal')

  expect(result.failed).toMatchObject([{ sessionId: SESSION, outcome: 'unconfirmed' }])
  expect(await statusNotes(host)).toContainEqual({
    text: AGENT_SESSION_RESTART_CONTINUATION_UNCONFIRMED_NOTE,
    tone: 'warning'
  })
  expect(await host.restartResume.listFailures()).toMatchObject([{ outcome: 'unconfirmed' }])
})
