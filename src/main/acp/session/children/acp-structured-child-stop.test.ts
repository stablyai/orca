import { readAgentJournalTurn } from '../../../../shared/agent-session/lifecycle/agent-session-turn-record'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  closeProviderTimelineRigs,
  SESSION
} from '../../../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
import { grokSubagentStop } from '../../acp-dialects/grok-subagent-stop'
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
  it.each([
    [{ cancelled: true, outcome: { kind: 'cancelled' } }, { cancelled: true }],
    [{ cancelled: true }, { cancelled: true }],
    [{ cancelled: false }, { cancelled: false }],
    [
      { cancelled: false, outcome: { kind: 'already_finished', status: 'failed' } },
      { cancelled: false, state: 'failed' }
    ],
    [
      { cancelled: false, outcome: { kind: 'already_finished', status: 'cancelled' } },
      { cancelled: false, state: 'stopped' }
    ],
    [{ cancelled: false, outcome: { kind: 'not_found' } }, { cancelled: false }],
    [{ cancelled: false, outcome: { kind: 'future_kind' } }, { cancelled: false }]
  ])('reads typed and legacy replies truthfully: %j', (payload, expected) => {
    expect(
      grokSubagentStop.response({ result: { subagentId: 'child', ...payload } }, 'child')
    ).toEqual(expected)
  })

  it.each([
    { result: null, error: 'refused' },
    { result: { subagentId: 'other', cancelled: true } },
    { result: { subagentId: 'child' } },
    { result: { subagentId: 'child', cancelled: true }, error: 'refused' },
    { result: { subagentId: 'child', cancelled: false, outcome: { kind: 'already_finished' } } },
    { cancelled: true }
  ])('rejects malformed, refused and mismatched replies: %j', (reply) => {
    expect(() => grokSubagentStop.response(reply, 'child')).toThrow(
      'invalid child cancellation response'
    )
  })

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
