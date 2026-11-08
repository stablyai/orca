import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { _internals } from '../../../agent-hooks/server'
import {
  closeProviderTimelineRigs,
  SESSION as ADAPTER_SESSION
} from '../../../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
import type {
  AcpScriptedAgent,
  FakeFrame
} from '../../process/testing/acp-scripted-agent.test-support'
import type { AgentChildWorkEvidence } from '../../../../shared/agent-status/child-work/agent-status-child-work-evidence'
import { openAcpAdapterRig, PROVIDER_SESSION } from '../testing/acp-structured-adapter.test-support'

beforeEach(() => _internals.resetCachesForTests())
const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => {
  vi.useRealTimers()
  for (const close of cleanup.splice(0)) {
    await close()
  }
  await closeProviderTimelineRigs()
})

const TASK = '01a10366-1e7f-7191-bcd1-fac24585851f'
const CHILD = `acp-task:${TASK}`

describe('Grok kill route check', () => {
  async function checked(answer: (agent: AcpScriptedAgent, frame: FakeFrame) => void) {
    const evidence: AgentChildWorkEvidence[] = []
    const rig = await openAcpAdapterRig({
      script: (agent) => agent.on('_x.ai/task/kill', (frame) => answer(agent, frame)),
      deps: { onChildWorkEvidence: (_session, edges) => evidence.push(...edges) }
    })
    cleanup.push(() => rig.adapter.closeAll())
    const acquiring = rig.acquire()
    if (vi.isFakeTimers()) {
      await rig.frame('_x.ai/task/kill')
      await vi.advanceTimersByTimeAsync(2_000)
    }
    await acquiring
    rig.child().agent.notify('_x.ai/task_backgrounded', {
      sessionId: PROVIDER_SESSION,
      update: { sessionUpdate: 'task_backgrounded', task_id: TASK, command: 'pnpm dev' }
    })
    await rig.settle()
    return { rig, evidence }
  }

  it('hides Stop only when Grok names the route unknown, and still lists the command', async () => {
    const { rig, evidence } = await checked((agent, frame) => {
      expect(frame.params).toEqual({})
      agent.fail(frame, -32601, 'Method not found')
    })
    expect(rig.adapter.backgroundTaskStops(ADAPTER_SESSION)?.supportsTaskStop).toBe(true)
    expect(evidence).toMatchObject([
      { type: 'live', child: { handle: { id: CHILD }, kind: 'command', stoppable: false } }
    ])
    await expect(
      rig.adapter.stopBackgroundTasks({ sessionId: ADAPTER_SESSION, fence: 1, taskIds: [CHILD] })
    ).rejects.toThrow('unavailable')
    expect(rig.sent('_x.ai/task/kill')).toHaveLength(1)
  })
})
