import { afterEach, describe, expect, it, vi } from 'vitest'
import { JsonlRpcTimelineLane } from '../../jsonl-rpc/timeline-lane'
import {
  closeProviderTimelineRigs,
  openProviderTimelineRig
} from '../../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
import { PiRpcTurns } from './rpc-turns'

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

  it('keeps an exhausted retry a failure when its records exceed the line limit', async () => {
    const h = await setup()
    await h.start()
    h.turns.skipped(
      'message_end',
      '{"type":"message_end","message":{"role":"assistant","content":['
    )
    h.turns.skipped(
      'auto_retry_end',
      '{"type":"auto_retry_end","success":false,"attempt":3,"finalError":"'
    )
    h.turns.receive({ type: 'agent_settled' })
    await h.flush()
    expect((await h.rig.turns())[0]?.outcome).toBe('failure')
  })
})

it.each([
  'OAuth refresh failed for openai-codex: token refresh failed (400): invalid_grant',
  // Pi 1.5.0 error text recorded by QA; the surrounding event is a fixture.
  '401 {"type":"error","error":{"type":"authentication_error","message":"Invalid bearer token"},"request_id":"req_011Cgmh94VzHrfkrvN866JGF"}'
])('keeps sign-in visible after an accepted turn fails: %s', async (errorMessage) => {
  const h = await setup()
  await h.start()
  h.turns.receive({
    type: 'message_end',
    message: {
      role: 'assistant',
      content: [],
      stopReason: 'error',
      errorMessage
    }
  })
  h.turns.receive({ type: 'agent_settled' })
  await h.flush()
  const rows = await h.rig.rows()
  expect(rows).toContainEqual(
    expect.objectContaining({
      body: expect.objectContaining({
        kind: 'status',
        failure: expect.objectContaining({
          kind: 'notSignedIn',
          detail: { text: errorMessage, audience: 'log' }
        })
      })
    })
  )
  expect((await h.rig.turns())[0]?.outcome).toBe('failure')
})
