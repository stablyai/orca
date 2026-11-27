import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createQueuedMessageTestRig,
  type QueuedMessageTestRig
} from '../../../../../native-chat/agent-session-wire/host/testing/structured-agent-session-queued-message-rig.test-fixture'
import { eventually } from '../../../../../native-chat/agent-session-wire/host/testing/structured-agent-session-queued-message-rig-provider.test-fixture'
import { HOST_TEST_SESSION as SESSION } from '../../../../../native-chat/agent-session-wire/host/testing/structured-agent-session-host-test-data.test-fixture'
import { setStructuredAgentSessionHost } from '../../../../../native-chat/agent-session-wire/host/structured-agent-session-registry'
import {
  closeStructuredAgentSessionChild,
  STARTING_AGENT_STOPPING_REASON
} from '../../../../agent-session/lifecycle/structured-agent-session-close'
import { observeStructuredSession } from '../../../../orchestration/terminal-authority/structured-sessions/structured-worker-authority'
import { sendStructuredWorkerPreamble } from './orchestration-structured-worker-session'
import type * as AwakeClock from '../../../../../power/awake-clock'

// The startup ceiling reads this clock; pinning it keeps a loaded runner from passing the ceiling before the send budget ends.
let pinnedNow: number | null = null
vi.mock('../../../../../power/awake-clock', async (importOriginal) => {
  const actual = await importOriginal<typeof AwakeClock>()
  return { ...actual, awakeNow: () => pinnedNow ?? actual.awakeNow() }
})

let rig: QueuedMessageTestRig | null = null

afterEach(async () => {
  pinnedNow = null
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
    // Long enough that a loaded runner registers the held start before the brief's wait ends.
    budgetMs: 250
  })
}

/** A worker whose agent process is still being acquired: a restarted host holds its next start. */
async function workerWithHeldStart(ceilingMs?: number): Promise<{
  current: QueuedMessageTestRig
  release: () => void
}> {
  const current = await createQueuedMessageTestRig({
    restartable: true,
    ...(ceilingMs ? { hostDeps: { startupLimits: { ceilingMs } } } : {})
  })
  rig = current
  await current.crashRestartHostFromDisk()
  setStructuredAgentSessionHost(current.host)
  // The rig's first host already started an agent; count only the held start's acquire from here.
  current.starts.mockClear()
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

  it('returns from a stop at once while the acquire never settles, without claiming stopped', async () => {
    const { current, release } = await workerWithHeldStart()
    expect(await sendBrief(current)).toBe('starting')
    // Held for the whole stop: the acquire never settles while the stop runs.
    // A close before the acquire begins cancels the start before any spawn; this case needs it held.
    await eventually(() => expect(current.starts).toHaveBeenCalled())
    const closed = await closeStructuredAgentSessionChild(SESSION)
    expect(closed).toMatchObject({
      stopped: false,
      closeAttempted: true,
      reason: STARTING_AGENT_STOPPING_REASON
    })
    let ended: boolean | undefined
    void closed.whenStartEnds?.then((stopped) => (ended = stopped))
    await Promise.resolve()
    expect(ended).toBeUndefined()
    expect(observeStructuredSession(SESSION).status).not.toBe('exited')
    // Teardown drains the host's start work, so let the held acquire go.
    release()
    await closed.whenStartEnds
  })

  it('closes the child a cancelled acquire brings up late, then settles stopped', async () => {
    const { current, release } = await workerWithHeldStart()
    expect(await sendBrief(current)).toBe('starting')
    // A close before the acquire begins cancels the start before any spawn; this case needs it held.
    await eventually(() => expect(current.starts).toHaveBeenCalled())
    const closed = await closeStructuredAgentSessionChild(SESSION)
    expect(closed.stopped).toBe(false)
    // The acquire ignored the abort and returns a live child after the close.
    release()
    expect(await closed.whenStartEnds).toBe(true)
    expect(current.releaseAcquisition).toHaveBeenCalledTimes(1)
    expect(observeStructuredSession(SESSION).status).toBe('exited')
    expect(briefSends(current)).toBe(0)
  })

  it('stops reading as starting once the ceiling fails a start whose acquire never returns', async () => {
    pinnedNow = 0
    const { current, release } = await workerWithHeldStart(300)
    expect(await sendBrief(current)).toBe('starting')
    // Pass the ceiling only once the acquire is held, so it fails a start that is acquiring.
    await eventually(() => expect(current.starts).toHaveBeenCalled())
    pinnedNow = 300
    // The ceiling rejects the held brief; the worker must not keep claiming its agent is starting.
    await eventually(async () => {
      const page = await current.host.history({ sessionId: SESSION, direction: 'tail' })
      expect(page.ok && page.page.submissions?.[0]?.dispatchState).toBe('rejected')
    })
    expect(current.host.reads.agentStarting(SESSION)).toBe(false)
    expect(observeStructuredSession(SESSION).reason).not.toMatch(/still starting/)
    release()
  })

  it('keeps an attached agent that has not taken its brief as pending', async () => {
    const current = await createQueuedMessageTestRig()
    rig = current
    setStructuredAgentSessionHost(current.host)
    expect(await sendBrief(current)).toBe('pending')
  })
})
