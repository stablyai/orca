import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  agentChildWorkStopEvidence,
  agentChildWorkStopTargets,
  type AgentChildWorkStopAcknowledgement
} from '../../shared/agent-child-work-stop-targets'
import type { AgentSessionRecord } from '../../shared/agent-session-record'
import { agentChildWorkLiveness } from '../../shared/agent-status-child-work-liveness'
import { conversationCommandBlocked } from '../native-chat/agent-session-wire/structured-conversation-command-admission'
import type { CapturedFrame } from './claude-captured-frame-builders.test-fixture'
import { RESUMED_BY_MESSAGE } from './claude-captured-task-frames.test-fixture'
import { hostWithParent, parent, producer } from './claude-child-work-producer-harness.test-fixture'

vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../telemetry/cohort-classifier', () => ({ getCohortAtEmit: vi.fn(() => ({})) }))
afterEach(() => vi.restoreAllMocks())

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: admission reads only the lease and the command/rewind records, all absent here.
const RECORD = { lease: {} } as unknown as AgentSessionRecord

/** Host records retain live work after provider roster removal. */
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
        journal: {
          snapshot: () => ({ items: [] }),
          cursor: () => ({ epoch: 'e', sequence: 0 }),
          item: () => null,
          submissions: () => [],
          runningTurn: () => null,
          itemFence: () => undefined,
          visitItems: () => undefined,
          wroteBeforeOpen: () => false
        },
        adapter: run.adapter
      },
      RECORD,
      { views: records(), open: agentChildWorkLiveness(records()) !== null }
    )
  const stopCalls = () =>
    run.claude.connections[0]!.calls.filter((call) => call.subtype === 'stop_task')
  expect(records()).toMatchObject([
    { membership: 'live', stoppable: true, providerId: 'agent-1', kind: 'agent' }
  ])
  expect(run.adapter.backgroundTaskState('session-1')).toBeNull()
  expect(blocked()?.message).toBe('Stop background tasks before using this command.')
  // Snapshot stop targets before dispatch; settle only acknowledged records.
  const stop = async (taskId?: string) => {
    const targets = agentChildWorkStopTargets(records(), taskId)
    const acknowledged: AgentChildWorkStopAcknowledgement[] = []
    const outcome = await run.adapter.stopBackgroundTasks({
      sessionId: 'session-1',
      fence: 7,
      taskIds: targets.map((target) => target.providerId),
      acknowledge: (acknowledgement) => void acknowledged.push(acknowledgement)
    })
    host.ingestStructuredChildWork(
      parent,
      agentChildWorkStopEvidence(targets, acknowledged, 6_500),
      'claude'
    )
    return outcome
  }
  const basis = () => host.getStructuredChildWork(parent).map((record) => record.outcomeBasis)
  return { run, records, blocked, stopCalls, stop, basis }
}

describe('a background Stop acts on the host child records', () => {
  it("stops the row's own task, which the records keep after the roster dropped it", async () => {
    const { records, blocked, stopCalls, stop, basis } = await droppedFromRoster()

    const outcome = await stop('agent-1')

    expect(outcome).toMatchObject({ cancelled: true })
    expect(stopCalls()).toEqual([{ subtype: 'stop_task', params: { taskId: 'agent-1' } }])
    expect(records()).toMatchObject([{ membership: 'settled', outcome: 'cancelled' }])
    expect(basis()).toEqual(['stop-acknowledged'])
    expect(blocked()).toBeNull()
  })

  it('stops every task the strip offers a stop when none is named', async () => {
    const { records, blocked, stopCalls, stop, basis } = await droppedFromRoster()

    const outcome = await stop()

    expect(outcome).toMatchObject({ cancelled: true })
    expect(stopCalls()).toEqual([{ subtype: 'stop_task', params: { taskId: 'agent-1' } }])
    expect(records()).toMatchObject([{ membership: 'settled', outcome: 'cancelled' }])
    expect(basis()).toEqual(['stop-acknowledged'])
    expect(blocked()).toBeNull()
  })

  it('leaves a task that ended on its own frame as it ended: its row offers no stop', async () => {
    const { run, records, stopCalls, stop } = await droppedFromRoster()
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

    const outcome = await stop('agent-1')

    expect(outcome).toMatchObject({ cancelled: false })
    expect(stopCalls()).toEqual([])
    expect(records()).toMatchObject([{ membership: 'settled', outcome: 'succeeded' }])
  })

  it('lets the task’s own completion, written before the acknowledgement, replace the Stop', async () => {
    const { run, records, stop } = await droppedFromRoster()
    await stop('agent-1')
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
