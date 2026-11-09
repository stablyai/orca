import { readAgentJournalTurn } from '../../../../shared/agent-session/lifecycle/agent-session-turn-record'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  closeProviderTimelineRigs,
  SESSION
} from '../../../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
import { openAcpAdapterRig, sendHello } from '../testing/acp-structured-adapter.test-support'

const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => {
  vi.useRealTimers()
  for (const close of cleanup.splice(0)) {
    await close()
  }
  await closeProviderTimelineRigs()
})

describe('Grok targeted child control contract', () => {
  it('bounds an unanswered route check without ending the parent connection', async () => {
    const rig = await openAcpAdapterRig({
      script: (agent) => {
        agent.on('_x.ai/subagent/cancel', () => {})
        agent.on('_x.ai/task/kill', (frame) => agent.fail(frame, -32601, 'Method not found'))
      }
    })
    cleanup.push(() => rig.adapter.closeAll())
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const acquiring = rig.acquire()
    await rig.frame('_x.ai/subagent/cancel')
    await vi.advanceTimersByTimeAsync(2_000)
    await acquiring
    vi.useRealTimers()
    expect(rig.adapter.backgroundTaskStops(SESSION)?.supportsTaskStop).toBe(false)
    expect(rig.child().closed).toBe(false)
    await sendHello(rig, 'after-probe')
    const prompt = await rig.frame('session/prompt')
    expect(prompt.params).toMatchObject({ sessionId: 'acp-session-1' })
    rig.child().agent.reply(prompt, { stopReason: 'end_turn' })
    await rig.settle()
    expect(
      (await rig.rig.rows()).flatMap((row) => readAgentJournalTurn(row.body) ?? [])
    ).toMatchObject([{ state: 'completed', outcome: 'success' }])
    expect(rig.ended).toEqual([])
  })
})
