import { afterEach, describe, expect, it, vi } from 'vitest'
import { JsonlRpcTimelineLane } from '../jsonl-rpc/timeline-lane'
import {
  closeProviderTimelineRigs,
  openProviderTimelineRig
} from '../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
import { PiRpcTurns } from './rpc-turns'

const disposals: (() => void)[] = []
afterEach(async () => {
  disposals.splice(0).forEach((dispose) => dispose())
  await closeProviderTimelineRigs()
})

const idleState = {
  sessionFile: '/host/folder/session.jsonl',
  isStreaming: false,
  isCompacting: false,
  pendingMessageCount: 0
}

async function setup(generation = 'wake-generation') {
  const rig = await openProviderTimelineRig({ agent: 'pi', sessionId: 'session-timeline' })
  const accepted = vi.fn(),
    failed = vi.fn(),
    idle = vi.fn(),
    settled = vi.fn()
  const request = vi.fn(async (): Promise<unknown> => idleState)
  const lane = new JsonlRpcTimelineLane({
    sink: rig.sink,
    sessionId: 'session-timeline',
    agent: 'pi',
    generation,
    namespace: 'session-timeline',
    pauseReading: vi.fn(),
    resumeReading: vi.fn(),
    onInputAccepted: accepted,
    onFailed: failed
  })
  const send = vi.fn(async () => {})
  const turns = new PiRpcTurns({ lane, generation, send, request, settled, failed, idle })
  disposals.push(() => {
    turns.end()
    lane.dispose()
  })
  const user = (text: string) =>
    turns.receive({
      type: 'message_end',
      message: { role: 'user', content: [{ type: 'text', text }] }
    })
  const answer = (text: string, stopReason = 'stop') =>
    turns.receive({
      type: 'message_end',
      message: { role: 'assistant', content: [{ type: 'text', text }], stopReason }
    })
  const flush = async () => {
    await new Promise<void>((resolve) => setImmediate(resolve))
    lane.flush()
  }
  const finish = async () => {
    turns.receive({ type: 'agent_end' })
    turns.receive({ type: 'agent_settled' })
    await flush()
  }
  return {
    rig,
    lane,
    turns,
    accepted,
    failed,
    idle,
    settled,
    request,
    send,
    user,
    answer,
    flush,
    finish
  }
}

describe('Pi extension-initiated turns', () => {
  it.each([true, false])(
    'keeps concurrent host input pending across an extension start (user wake: %s)',
    async (userWake) => {
      const h = await setup()
      const commit = Promise.withResolvers<void>()
      const dispatch = h.turns.submit(
        'host-input',
        1,
        { type: 'prompt', message: 'Host follow-up' },
        () => commit.promise
      )
      h.turns.receive({ type: 'agent_start' })
      commit.resolve()
      await dispatch
      if (userWake) {
        h.user('Inspect subagent updates above.')
      }
      expect(h.accepted).not.toHaveBeenCalled()
      h.answer('Read the background result.')
      h.user('Host follow-up')
      h.answer('Handled the host follow-up.')
      await h.finish()
      expect(h.accepted.mock.calls).toEqual([['host-input']])
      expect((await h.rig.turns()).map((turn) => turn.outcome)).toEqual(['success'])
    }
  )

  it('continues an idle parent after a background result without a host dispatch', async () => {
    const h = await setup()
    await h.turns.submit('original', 1, { type: 'prompt', message: 'review in background' })
    h.turns.receive({ type: 'agent_start' })
    h.user('review in background')
    h.answer('Review started.')
    await h.finish()
    h.turns.receive({
      type: 'message_end',
      message: {
        role: 'custom',
        customType: 'subagent-notify',
        content: 'Review complete: no issues.'
      }
    })
    expect(() => h.turns.receive({ type: 'agent_start' })).not.toThrow()
    expect(h.turns.working).toBe(true)
    h.user('Inspect subagent updates above and continue.')
    h.answer('Reviewed the result. No further changes needed.')
    await h.finish()
    expect((await h.rig.turns()).map((turn) => turn.outcome)).toEqual(['success', 'success'])
    expect((await h.rig.rows()).filter((row) => row.body.kind === 'message')).toHaveLength(2)
    expect(h.accepted.mock.calls).toEqual([['original']])
    expect(h.send).toHaveBeenCalledTimes(1)
    expect(h.idle).toHaveBeenCalledTimes(2)
    expect(h.failed).not.toHaveBeenCalled()
    expect(h.turns.working).toBe(false)
  })

  it('does not consume queued input on duplicate starts or lose the initial echo boundary', async () => {
    const h = await setup()
    await h.turns.submit('first', 1, { type: 'prompt', message: 'first' })
    h.turns.receive({ type: 'agent_start' })
    await h.turns.submit('queued', 2, { type: 'prompt', message: 'queued' })
    h.turns.receive({ type: 'agent_start' })
    expect(h.accepted.mock.calls).toEqual([['first']])
    h.user('first')
    expect(h.accepted.mock.calls).toEqual([['first']])
    h.turns.receive({
      type: 'message_end',
      message: { role: 'custom', content: 'Background result' }
    })
    h.user('queued')
    expect(h.accepted.mock.calls).toEqual([['first'], ['queued']])
    h.answer('Both inputs handled.')
    await h.finish()
    await h.finish()
    expect(await h.rig.turns()).toHaveLength(1)
    expect(h.idle).toHaveBeenCalledTimes(1)
  })

  it('preserves cancellation and accepts a later independent extension run', async () => {
    const h = await setup()
    h.turns.receive({ type: 'agent_start' })
    h.turns.stop()
    h.turns.receive({ type: 'agent_start' })
    h.answer('', 'aborted')
    await h.finish()
    h.turns.receive({ type: 'agent_start' })
    h.answer('A later completion.')
    await h.finish()
    expect((await h.rig.turns()).map((turn) => turn.outcome)).toEqual(['cancellation', 'success'])
  })

  it('invalidates the previous idle probe when an extension starts before it resolves', async () => {
    const h = await setup()
    const probe = Promise.withResolvers<unknown>()
    h.request.mockImplementationOnce(() => probe.promise)
    await h.turns.submit('first', 1, { type: 'prompt', message: 'first' })
    h.turns.receive({ type: 'agent_start' })
    h.user('first')
    h.turns.receive({ type: 'agent_settled' })
    await Promise.resolve()
    h.turns.receive({ type: 'agent_start' })
    probe.resolve(idleState)
    await h.flush()
    expect(h.idle).not.toHaveBeenCalled()
    h.answer('Continuation completed.')
    await h.finish()
    expect(h.idle).toHaveBeenCalledTimes(1)
  })

  it('records an autonomous failure and ignores late events after the generation ends', async () => {
    const h = await setup()
    h.turns.receive({ type: 'agent_start' })
    h.answer('', 'error')
    await h.finish()
    expect((await h.rig.turns())[0]?.outcome).toBe('failure')
    expect(
      (await h.rig.rows()).some((row) => row.body.kind === 'status' && row.body.tone === 'error')
    ).toBe(true)
    h.turns.end()
    h.turns.receive({ type: 'agent_start' })
    h.answer('stale')
    await h.finish()
    expect(await h.rig.turns()).toHaveLength(1)
    expect(h.idle).toHaveBeenCalledTimes(1)
  })
})
