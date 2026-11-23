import { afterEach, expect, it, vi } from 'vitest'
import { AgentSessionRecoveryCapsule } from '../../../../runtime/agent-session/records/agent-session-recovery-capsule'
import { AGENT_SESSION_RESTART_CONTINUATION_NOTE } from '../../../../../shared/agent-session/lifecycle/stopping/agent-session-restart-continuation'
import {
  interruptedRestart,
  statusNotes
} from './structured-agent-session-restart-interruption.test-fixture'
import {
  HOST_TEST_NOW as NOW,
  HOST_TEST_SESSION as SESSION,
  HOST_TEST_THREAD as THREAD
} from './structured-agent-session-host-test-data.test-fixture'

afterEach(() => vi.restoreAllMocks())

it('answers once the chat is handed over, and its late answer settles only that chat', async () => {
  const state = await interruptedRestart()
  await state.host.restartResume.list()
  // The agent takes the message but never answers, like one stuck retrying its API.
  state.dispatch.mockResolvedValueOnce({ state: 'admitted' })

  const result = await state.host.restartResume.continueAfterRestart([SESSION], 'modal')

  expect(result.continued).toEqual([{ sessionId: SESSION, outcome: 'pending' }])
  expect(result.failed).toEqual([])
  expect(await statusNotes(state.host)).not.toContainEqual(
    expect.objectContaining({ text: AGENT_SESSION_RESTART_CONTINUATION_NOTE })
  )

  const history = await state.host.history({ sessionId: SESSION, direction: 'tail' })
  const continuation = history.ok ? history.page.submissions.at(-1)?.clientMessageId : undefined
  await state.host.settleLateDispatch({
    sessionId: SESSION,
    clientMessageId: continuation!,
    providerIdentity: { provider: 'codex', threadId: THREAD, turnId: 'late-turn', ordinal: 1 }
  })

  await vi.waitFor(async () =>
    expect(await statusNotes(state.host)).toContainEqual(
      expect.objectContaining({ text: AGENT_SESSION_RESTART_CONTINUATION_NOTE })
    )
  )
  const capsule = new AgentSessionRecoveryCapsule(state.root)
  await vi.waitFor(async () => expect(await capsule.list(NOW)).toEqual([]))
  expect(await capsule.listFailed(NOW)).toEqual([])
  await state.host.flushAllStreamedEvents()
})
