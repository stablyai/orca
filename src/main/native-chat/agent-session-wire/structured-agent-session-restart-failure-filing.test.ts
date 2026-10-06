import { afterEach, expect, it, vi } from 'vitest'
import { agentJournalSubmissionKey } from '../../../shared/agent-session-journal-item-key'
import type { AgentSessionTurnCompletionEvent } from '../../../shared/agent-session-wire'
import { STRUCTURED_AGENT_SESSION_START_RETRY_DELAYS_MS } from '../../../shared/structured-agent-session-start-retry'
import { AgentSessionRecoveryCapsule } from '../../runtime/agent-session-recovery-capsule'
import {
  AGENT_SESSION_RESTART_CONTINUATION_NOTE,
  AGENT_SESSION_RESTART_CONTINUATION_REFUSED_NOTE,
  AGENT_SESSION_RESTART_CONTINUATION_UNCONFIRMED_NOTE
} from '../../../shared/agent-session-restart-continuation'
import { AgentSessionPreSpawnError } from './structured-agent-session-adapter'
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

/** A start refused before it ran, which Orca tries again. */
const ACCOUNT_SWITCHING = new AgentSessionPreSpawnError(
  new Error('a Claude account switch is in progress'),
  { reason: 'accountSwitchInProgress' }
)

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

// The continuation is accepted and its agent's start is refused before it ran. Like any message
// refused so, it says why and waits for its next try: the batch counts it done at once, the restart
// list files nothing, and no note claims the agent did or did not carry on.
it('files nothing and notes nothing while the continuation waits for its next try', async () => {
  const { host, acquire } = await interruptedRestart()
  await host.restartResume.list()
  acquire.mockRejectedValueOnce(ACCOUNT_SWITCHING)
  // The next try is booked and never comes: the batch must not wait for it.
  host.deps.setStartRetryTimer = () => () => {}

  const startedAt = Date.now()
  const result = await host.restartResume.continueAfterRestart([SESSION], 'modal')

  expect(Date.now() - startedAt).toBeLessThan(5_000)
  expect(result.continued).toEqual([{ sessionId: SESSION, outcome: 'pending', startFailed: true }])
  expect(result.failed).toEqual([])
  expect(await host.restartResume.listFailures()).toEqual([])
  const notes = (await statusNotes(host)).map((note) => note.text)
  expect(notes).not.toContain(AGENT_SESSION_RESTART_CONTINUATION_REFUSED_NOTE)
  expect(notes).not.toContain(AGENT_SESSION_RESTART_CONTINUATION_UNCONFIRMED_NOTE)
  expect((await host.journalSnapshot(SESSION)).submissions).toMatchObject([
    {
      dispatchState: 'pending',
      startRetry: { attempts: 1, reason: 'A Claude account switch is in progress.' }
    }
  ])
})

// Out of tries, the continuation reads Failed in the chat with its own Retry, and the chat's failure
// is announced once — when it first failed, not again at the last try.
it('reads Failed once its tries run out, with one failure notification', async () => {
  const { host, acquire, clock } = await interruptedRestart()
  await host.restartResume.list()
  acquire.mockRejectedValue(ACCOUNT_SWITCHING)
  // Each booked try comes due at once.
  host.deps.setStartRetryTimer = (delayMs, run) => {
    const timer = setTimeout(() => {
      clock.now += delayMs
      run()
    }, 0)
    return () => clearTimeout(timer)
  }
  const completions: AgentSessionTurnCompletionEvent[] = []
  host.subscribeTurnCompletions({ id: 'dot-1', emit: (event) => completions.push(event) })

  await host.restartResume.continueAfterRestart([SESSION], 'modal')

  await vi.waitFor(async () =>
    expect((await host.journalSnapshot(SESSION)).submissions).toMatchObject([
      {
        dispatchState: 'rejected',
        reason: 'A Claude account switch is in progress. Try again after it finishes.'
      }
    ])
  )
  // The first try and one for each booked retry.
  expect(acquire).toHaveBeenCalledTimes(STRUCTURED_AGENT_SESSION_START_RETRY_DELAYS_MS.length + 1)
  const [continuation] = (await host.journalSnapshot(SESSION)).submissions
  await host.flushAllStreamedEvents()
  expect(
    completions.filter(
      (event) =>
        event.type === 'completion' &&
        event.completion.turnId === agentJournalSubmissionKey(continuation!.clientMessageId)
    )
  ).toEqual([
    expect.objectContaining({ completion: expect.objectContaining({ outcome: 'failure' }) })
  ])
  expect(await host.restartResume.listFailures()).toEqual([])
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
