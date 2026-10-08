import { afterEach, describe, expect, it, vi } from 'vitest'
import { JsonlRpcTimelineLane } from '../jsonl-rpc/timeline-lane'
import {
  closeProviderTimelineRigs,
  openProviderTimelineRig
} from '../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
import { PiRpcTurns } from './rpc-turns'
import { PiRpcPromptDelivery } from './rpc-prompt-delivery'

const state = (overrides: Record<string, unknown> = {}) => ({
  sessionFile: '/host/session.jsonl',
  isStreaming: false,
  isCompacting: false,
  pendingMessageCount: 0,
  ...overrides
})
const pending: (() => void)[] = []
afterEach(async () => {
  pending.splice(0).forEach((end) => end())
  await closeProviderTimelineRigs()
  vi.useRealTimers()
})

async function setup(request = vi.fn(async (_command: string): Promise<unknown> => state())) {
  const rig = await openProviderTimelineRig({ agent: 'pi', sessionId: 'session-timeline' })
  const accepted = vi.fn(),
    failed = vi.fn(),
    idle = vi.fn(),
    settled = vi.fn()
  const lane = new JsonlRpcTimelineLane({
    sink: rig.sink,
    sessionId: 'session-timeline',
    agent: 'pi',
    generation: 'generation-1',
    namespace: 'session-timeline',
    pauseReading: vi.fn(),
    resumeReading: vi.fn(),
    onInputAccepted: accepted,
    onFailed: failed
  })
  const send = vi.fn(async (_frame: Record<string, unknown>) => {})
  const turns = new PiRpcTurns({
    lane,
    generation: 'generation-1',
    send,
    request,
    settled,
    failed,
    idle
  })
  pending.push(() => {
    turns.end()
    lane.dispose()
  })
  const start = async () => {
    await turns.submit('send-1', 100, { type: 'prompt', message: 'hello' })
    turns.receive({ type: 'agent_start' })
  }
  const flush = async () => {
    await Promise.resolve()
    await Promise.resolve()
    lane.flush()
  }
  return { rig, lane, turns, request, accepted, failed, idle, settled, start, flush, send }
}

describe('Pi turn settlement races', () => {
  it('chooses steering after asynchronous dispatch admission finishes', async () => {
    const h = await setup()
    await h.turns.submit('first', 1, { type: 'prompt', message: 'first' })
    const gate = Promise.withResolvers<void>()
    const second = h.turns.submit(
      'second',
      2,
      { type: 'prompt', message: 'second', streamingBehavior: 'followUp' },
      () => gate.promise
    )
    h.turns.receive({ type: 'agent_start' })
    gate.resolve()
    await second
    expect(h.send.mock.calls[1]?.[0]).toMatchObject({
      message: 'second',
      streamingBehavior: 'steer'
    })
  })
  it('waits for agent_settled and a host idle probe after agent_end', async () => {
    const h = await setup()
    await h.start()
    h.turns.receive({ type: 'agent_end' })
    await h.flush()
    expect(h.request).not.toHaveBeenCalled()
    expect(h.idle).not.toHaveBeenCalled()
    expect(await h.rig.turns()).toHaveLength(1)
    expect((await h.rig.turns())[0]?.state).toBe('running')
    h.turns.receive({ type: 'agent_settled' })
    await h.flush()
    expect(h.request).toHaveBeenCalledWith('get_state')
    expect((await h.rig.turns())[0]?.outcome).toBe('success')
    expect(h.idle).toHaveBeenCalledTimes(1)
  })

  it('invalidates an old idle probe when detached compaction starts after settlement', async () => {
    let release: ((value: unknown) => void) | undefined
    const request = vi.fn(
      (_command: string) =>
        new Promise<unknown>((resolve) => {
          release = resolve
        })
    )
    const h = await setup(request)
    await h.start()
    h.turns.receive({ type: 'agent_settled' })
    await Promise.resolve()
    expect(request).toHaveBeenCalledTimes(1)
    h.turns.receive({ type: 'auto_compaction_start' })
    release?.(state())
    await h.flush()
    expect(h.idle).not.toHaveBeenCalled()
    expect((await h.rig.turns())[0]?.state).toBe('running')
    h.turns.receive({ type: 'auto_compaction_end' })
    await Promise.resolve()
    expect(request.mock.calls.filter(([command]) => command === 'get_state')).toHaveLength(2)
    release?.(state())
    await h.flush()
    expect((await h.rig.turns())[0]?.outcome).toBe('success')
  })

  it('keeps a busy generation open and rejects a probe made stale by new activity', async () => {
    let release: ((value: unknown) => void) | undefined
    const request = vi.fn(
      (_command: string) =>
        new Promise<unknown>((resolve) => {
          release = resolve
        })
    )
    const h = await setup(request)
    await h.start()
    h.turns.receive({ type: 'agent_settled' })
    await Promise.resolve()
    release?.(state({ isStreaming: true }))
    await h.flush()
    expect(h.idle).not.toHaveBeenCalled()
    h.turns.receive({ type: 'agent_settled' })
    await Promise.resolve()
    h.turns.receive({ type: 'message_update', message: { role: 'assistant', content: [] } })
    release?.(state())
    await h.flush()
    expect(h.idle).not.toHaveBeenCalled()
    h.turns.receive({ type: 'agent_settled' })
    await Promise.resolve()
    release?.(state())
    await h.flush()
    expect((await h.rig.turns())[0]?.outcome).toBe('success')
  })

  it('settles a provider-handled local command without agent events', async () => {
    const h = await setup()
    await h.turns.submit('local-command', 100, { type: 'prompt', message: '/help' })
    h.turns.receive({
      type: 'response',
      command: 'prompt',
      success: true,
      data: { disposition: 'handled', agentInvoked: false }
    })
    await h.flush()
    expect(h.accepted).toHaveBeenCalledWith('local-command')
    expect((await h.rig.turns())[0]?.outcome).toBe('success')
    expect(h.idle).toHaveBeenCalledTimes(1)
  })

  it('keeps exhausted auto retry as failure, while successful retry clears it', async () => {
    for (const succeeded of [false, true]) {
      const h = await setup()
      await h.start()
      h.turns.receive({
        type: 'message_end',
        message: {
          role: 'assistant',
          content: [],
          stopReason: 'error',
          errorMessage: 'provider failed'
        }
      })
      h.turns.receive({ type: 'auto_retry_start' })
      h.turns.receive({ type: 'auto_retry_end', success: succeeded })
      if (succeeded) {
        h.turns.receive({
          type: 'message_end',
          message: { role: 'assistant', content: [], stopReason: 'stop' }
        })
      }
      h.turns.receive({ type: 'agent_settled' })
      await h.flush()
      expect((await h.rig.turns())[0]?.outcome).toBe(succeeded ? 'success' : 'failure')
    }
  })
})

describe('Pi prompt acknowledgement retries', () => {
  it('retries only the exact transient auth prefix eight times at 250 ms', async () => {
    vi.useFakeTimers()
    const send = vi.fn(async () => {})
    const settled = vi.fn()
    const delivery = new PiRpcPromptDelivery({
      send,
      settled,
      accepted: vi.fn(),
      commandOnly: vi.fn(),
      rejectedAfterAcceptance: vi.fn(),
      failed: vi.fn()
    })
    await delivery.submit('send-1', 100, { type: 'prompt', message: 'hello' })
    for (let attempt = 0; attempt < 8; attempt++) {
      delivery.reply({
        type: 'response',
        command: 'prompt',
        success: false,
        error: 'No API key found for provider'
      })
      await vi.advanceTimersByTimeAsync(249)
      expect(send).toHaveBeenCalledTimes(attempt + 1)
      await vi.advanceTimersByTimeAsync(1)
      expect(send).toHaveBeenCalledTimes(attempt + 2)
    }
    delivery.reply({
      type: 'response',
      command: 'prompt',
      success: false,
      error: 'No API key found for provider'
    })
    await vi.advanceTimersByTimeAsync(250)
    expect(send).toHaveBeenCalledTimes(9)
    expect(settled).toHaveBeenCalledWith('send-1', expect.objectContaining({ state: 'rejected' }))
    await delivery.submit('send-2', 101, { type: 'prompt', message: 'again' })
    delivery.reply({
      type: 'response',
      command: 'prompt',
      success: false,
      error: 'No API key found elsewhere'
    })
    await vi.advanceTimersByTimeAsync(250)
    expect(send).toHaveBeenCalledTimes(10)
    delivery.end()
  })
})
