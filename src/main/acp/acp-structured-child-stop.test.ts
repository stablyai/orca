import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  closeProviderTimelineRigs,
  SESSION
} from '../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
import { grokSubagentStop } from './acp-dialects/grok-subagent-stop'
import { openAcpAdapterRig } from './acp-structured-adapter.test-support'

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

  it.each([-32601, -32000, -32603, -32602])(
    'hides targeted Stop when the non-mutating route check fails with %s',
    async (code) => {
      const rig = await openAcpAdapterRig({
        script: (agent) => {
          agent.on('_x.ai/subagent/cancel', (frame) => {
            expect(frame.params).toEqual({})
            agent.fail(frame, code, 'Unavailable')
          })
          agent.on('_x.ai/task/kill', (frame) => agent.fail(frame, -32601, 'Method not found'))
        }
      })
      cleanup.push(() => rig.adapter.closeAll())
      await rig.acquire()
      expect(rig.adapter.backgroundTaskStops(SESSION)).toEqual({
        supportsTaskStop: false,
        supportsStopAll: false
      })
      await expect(
        rig.adapter.stopBackgroundTasks({ sessionId: SESSION, fence: 1, taskIds: ['child'] })
      ).rejects.toThrow('unavailable')
      expect(rig.child().agent.frames.filter((frame) => frame.method === 'session/cancel')).toEqual(
        []
      )
    }
  )

  it('enables only the proved route and checks the acquisition fence before addressing a child', async () => {
    const rig = await openAcpAdapterRig()
    cleanup.push(() => rig.adapter.closeAll())
    await rig.acquire()
    expect(rig.adapter.backgroundTaskStops(SESSION)).toEqual({
      supportsTaskStop: true,
      supportsStopAll: false
    })
    await expect(
      rig.adapter.stopBackgroundTasks({ sessionId: SESSION, fence: 2, taskIds: ['child'] })
    ).rejects.toThrow('unavailable')
    expect(
      rig.child().agent.frames.filter((frame) => frame.method === '_x.ai/subagent/cancel')
    ).toHaveLength(1)
  })

  it('bounds an unanswered route check without ending the parent connection', async () => {
    const rig = await openAcpAdapterRig({
      script: (agent) => {
        agent.on('_x.ai/subagent/cancel', () => {})
        agent.on('_x.ai/task/kill', (frame) => agent.fail(frame, -32601, 'Method not found'))
      }
    })
    cleanup.push(() => rig.adapter.closeAll())
    await rig.acquire()
    expect(rig.adapter.backgroundTaskStops(SESSION)?.supportsTaskStop).toBe(false)
    expect(rig.child().closed).toBe(false)
  })
})
