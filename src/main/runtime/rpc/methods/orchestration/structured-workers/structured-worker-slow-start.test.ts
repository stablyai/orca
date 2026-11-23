import { afterEach, describe, expect, it } from 'vitest'
import {
  createQueuedMessageTestRig,
  type QueuedMessageTestRig
} from '../../../../../native-chat/agent-session-wire/host/testing/structured-agent-session-queued-message-rig.test-fixture'
import { eventually } from '../../../../../native-chat/agent-session-wire/host/testing/structured-agent-session-queued-message-rig-provider.test-fixture'
import { HOST_TEST_SESSION as SESSION } from '../../../../../native-chat/agent-session-wire/host/testing/structured-agent-session-host-test-data.test-fixture'
import { setStructuredAgentSessionHost } from '../../../../../native-chat/agent-session-wire/host/structured-agent-session-registry'
import {
  closeStructuredAgentSessionChild,
  STARTING_AGENT_STOPPED_REASON
} from '../../../../agent-session/lifecycle/structured-agent-session-close'
import { observeStructuredSession } from '../../../../orchestration/terminal-authority/structured-sessions/structured-worker-authority'
import { sendStructuredWorkerPreamble } from './orchestration-structured-worker-session'

let rig: QueuedMessageTestRig | null = null

afterEach(async () => {
  setStructuredAgentSessionHost(null)
  await rig?.dispose()
  rig = null
})

function sendBrief(current: QueuedMessageTestRig) {
  return sendStructuredWorkerPreamble({
    host: current.host,
    sessionId: SESSION,
    dispatchId: 'ctx_slow',
    preamble: 'the brief',
    from: { kind: 'agent', senders: [], orchestration: null },
    budgetMs: 50
  })
}

/** A worker whose agent process is still being acquired: a restarted host holds its next start. */
async function workerWithHeldStart(): Promise<{
  current: QueuedMessageTestRig
  release: () => void
}> {
  const current = await createQueuedMessageTestRig({ restartable: true })
  rig = current
  await current.crashRestartHostFromDisk()
  setStructuredAgentSessionHost(current.host)
  return { current, release: current.holdNextStart() }
}

function briefSends(current: QueuedMessageTestRig): number {
  return current.dispatch.mock.calls.filter(([input]) =>
    JSON.stringify(input).includes('the brief')
  ).length
}

describe('a structured worker whose agent is slow to start', () => {
  it('reads as starting past the budget, then delivers its brief once when the agent attaches', async () => {
    const { current, release } = await workerWithHeldStart()
    expect(await sendBrief(current)).toBe('starting')
    expect(briefSends(current)).toBe(0)
    release()
    await eventually(() => expect(briefSends(current)).toBe(1))
    await current.host.flushAllStreamedEvents()
    expect(briefSends(current)).toBe(1)
  })

  it('stops as stopped, with the plain reason, while its agent is still starting', async () => {
    const { current, release } = await workerWithHeldStart()
    expect(await sendBrief(current)).toBe('starting')
    expect(await closeStructuredAgentSessionChild(SESSION)).toEqual({
      stopped: true,
      closeAttempted: true,
      reason: STARTING_AGENT_STOPPED_REASON
    })
    release()
    // The cancelled start settles once its held acquire returns, and never hands the brief over.
    await eventually(() => expect(observeStructuredSession(SESSION).status).toBe('exited'))
    expect(briefSends(current)).toBe(0)
  })

  it('keeps an attached agent that has not taken its brief as pending', async () => {
    const current = await createQueuedMessageTestRig()
    rig = current
    setStructuredAgentSessionHost(current.host)
    expect(await sendBrief(current)).toBe('pending')
  })
})
