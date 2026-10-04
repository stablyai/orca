// A background Stop reaches what the host's child records say runs, the same records that draw the
// strip's Stop and decide whether /clear, /compact and rewind wait. Replayed from a captured frame
// order through the real adapter and a real hook server.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { agentChildWorkStopTargets } from '../../shared/agent-child-work-stop-targets'
import type { AgentSessionRecord } from '../../shared/agent-session-record'
import { conversationCommandBlocked } from '../native-chat/agent-session-wire/structured-conversation-command-admission'
import type { CapturedFrame } from './claude-captured-frame-builders.test-fixture'
import { RESUMED_BY_MESSAGE } from './claude-captured-task-frames.test-fixture'
import { hostWithParent, parent, producer } from './claude-child-work-producer-harness.test-fixture'

vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../telemetry/cohort-classifier', () => ({ getCohortAtEmit: vi.fn(() => ({})) }))
afterEach(() => vi.restoreAllMocks())

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: admission reads only the lease and the command/rewind records, all absent here.
const RECORD = { lease: {} } as unknown as AgentSessionRecord

/** A backgrounded agent the CLI's roster then drops with no ending of its own: the records keep
 *  it live, the provider tracker does not. */
async function droppedFromRoster() {
  const host = hostWithParent()
  const run = await producer(host)
  const launch: CapturedFrame[] = RESUMED_BY_MESSAGE.filter((captured) => captured.at < 5_077)
  run.replay(launch)
  run.replay([
    { at: 6_000, frame: { type: 'system', subtype: 'background_tasks_changed', tasks: [] } }
  ])
  const records = () => host.getStructuredChildWorkViews(parent)
  const blocked = () =>
    conversationCommandBlocked(
      {
        sessionId: 'session-1',
        fence: 7,
        journal: { snapshot: () => ({ items: [] }), submissions: () => [] },
        adapter: run.adapter
      },
      RECORD,
      records()
    )
  const stopCalls = () =>
    run.claude.connections[0]!.calls.filter((call) => call.subtype === 'stop_task')
  expect(records()).toMatchObject([
    { membership: 'live', stoppable: true, providerId: 'agent-1', kind: 'agent' }
  ])
  expect(run.adapter.backgroundTaskState('session-1')).toBeNull()
  expect(blocked()?.message).toBe('Stop background tasks before using this command.')
  return { run, records, blocked, stopCalls }
}

describe('a background Stop acts on the host child records', () => {
  it("stops the row's own task, which the records keep after the roster dropped it", async () => {
    const { run, records, blocked, stopCalls } = await droppedFromRoster()

    const outcome = await run.adapter.stopBackgroundTasks({
      sessionId: 'session-1',
      fence: 7,
      taskIds: agentChildWorkStopTargets(records(), 'agent-1')
    })

    expect(outcome).toEqual({ cancelled: true })
    expect(stopCalls()).toEqual([{ subtype: 'stop_task', params: { taskId: 'agent-1' } }])
    // The CLI acknowledges a task it no longer runs with no frame: the acknowledgement ends it.
    expect(records()).toMatchObject([{ membership: 'settled', outcome: 'cancelled' }])
    expect(blocked()).toBeNull()
  })

  it('stops every task the strip offers a stop when none is named', async () => {
    const { run, records, blocked, stopCalls } = await droppedFromRoster()

    const outcome = await run.adapter.stopBackgroundTasks({
      sessionId: 'session-1',
      fence: 7,
      taskIds: agentChildWorkStopTargets(records())
    })

    expect(outcome).toEqual({ cancelled: true })
    expect(stopCalls()).toEqual([{ subtype: 'stop_task', params: { taskId: 'agent-1' } }])
    expect(records()).toMatchObject([{ membership: 'settled', outcome: 'cancelled' }])
    expect(blocked()).toBeNull()
  })

  it('leaves a task that ended on its own frame as it ended: its row offers no stop', async () => {
    const { run, records, stopCalls } = await droppedFromRoster()
    run.replay([
      {
        at: 7_000,
        frame: {
          type: 'system',
          subtype: 'task_updated',
          task_id: 'agent-1',
          patch: { status: 'completed' }
        }
      }
    ])

    const outcome = await run.adapter.stopBackgroundTasks({
      sessionId: 'session-1',
      fence: 7,
      taskIds: agentChildWorkStopTargets(records(), 'agent-1')
    })

    // The finished row offers no stop, so nothing reaches the CLI and the outcome stands.
    expect(outcome).toEqual({ cancelled: false })
    expect(stopCalls()).toEqual([])
    expect(records()).toMatchObject([{ membership: 'settled', outcome: 'succeeded' }])
  })

  it('lets the task’s own completion, written before the acknowledgement, replace the Stop', async () => {
    const { run, records } = await droppedFromRoster()
    await run.adapter.stopBackgroundTasks({
      sessionId: 'session-1',
      fence: 7,
      taskIds: agentChildWorkStopTargets(records(), 'agent-1')
    })
    expect(records()).toMatchObject([{ membership: 'settled', outcome: 'cancelled' }])

    // The completion the CLI wrote before its answer, which the SDK delivered after it.
    run.replay([
      {
        at: 7_000,
        frame: {
          type: 'system',
          subtype: 'task_notification',
          task_id: 'agent-1',
          status: 'completed',
          summary: 'Found 3 call sites'
        }
      }
    ])
    expect(records()).toMatchObject([
      { membership: 'settled', outcome: 'succeeded', lastMessage: 'Found 3 call sites' }
    ])
  })

  it('never lets an acknowledged Stop replace an ending the task reported itself', async () => {
    const { run, records } = await droppedFromRoster()
    // The task's own failure lands; a Stop the user sent before it is acknowledged after.
    run.replay([
      {
        at: 7_000,
        frame: {
          type: 'system',
          subtype: 'task_notification',
          task_id: 'agent-1',
          status: 'failed',
          summary: 'Exit code 1'
        }
      }
    ])
    await run.adapter.stopBackgroundTasks({
      sessionId: 'session-1',
      fence: 7,
      taskIds: ['agent-1']
    })
    expect(records()).toMatchObject([
      { membership: 'settled', outcome: 'failed', lastMessage: 'Exit code 1' }
    ])
  })
})
