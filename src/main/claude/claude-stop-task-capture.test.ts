// A real Claude CLI 2.1.280 Stop of a background shell at idle
// (`__fixtures__/claude-lifecycle-capture-stop-task.jsonl`), replayed through the real adapter and a
// real hook server: the CLI writes the task's own ending before it acknowledges the Stop, so a
// /clear waiting on background tasks never waits on an owed ending and may run once the CLI idles.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { agentChildWorkStopTargets } from '../../shared/agent-child-work-stop-targets'
import { readAgentJournalTurn } from '../../shared/agent-session-turn-record'
import { queuedClearWait } from '../native-chat/agent-session-wire/structured-conversation-clear'
import {
  result,
  spawn,
  system,
  toolResult,
  type CapturedFrame
} from './claude-captured-frame-builders.test-fixture'
import { hostWithParent, parent, producer } from './claude-child-work-producer-harness.test-fixture'
import { PROVIDER_SESSION_ID } from './claude-structured-session-test-support'

vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../telemetry/cohort-classifier', () => ({ getCohortAtEmit: vi.fn(() => ({})) }))

type StopCapture = {
  providerSessionId: string
  request: Record<string, unknown>
  /** What the CLI wrote between the request and its answer, then after the answer. */
  beforeAnswer: CapturedFrame[]
  afterAnswer: CapturedFrame[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function loadStopCapture(): StopCapture {
  const path = join(__dirname, '__fixtures__', 'claude-lifecycle-capture-stop-task.jsonl')
  const capture: StopCapture = {
    providerSessionId: '',
    request: {},
    beforeAnswer: [],
    afterAnswer: []
  }
  let answered = false
  for (const line of readFileSync(path, 'utf8').trim().split('\n')) {
    const event: unknown = JSON.parse(line)
    if (!isRecord(event) || typeof event.at !== 'number') {
      throw new Error('capture line is not a recorded event')
    }
    if (event.kind === 'meta' && typeof event.providerSessionId === 'string') {
      capture.providerSessionId = event.providerSessionId
    } else if (event.kind === 'control' && isRecord(event.request)) {
      capture.request = event.request
    } else if (event.kind === 'control-answer') {
      answered = true
    } else if (event.kind === 'frame' && isRecord(event.frame)) {
      const frame: unknown = JSON.parse(
        JSON.stringify(event.frame).replaceAll(capture.providerSessionId, PROVIDER_SESSION_ID)
      )
      if (!isRecord(frame)) {
        throw new Error('mapped frame is not a record')
      }
      ;(answered ? capture.afterAnswer : capture.beforeAnswer).push({ at: event.at, frame })
    } else {
      throw new Error(`capture line has unknown kind: ${String(event.kind)}`)
    }
  }
  return capture
}

const TASK = 'bhgj726rb'
const DESCRIPTION = 'Sleep for 10 minutes in background'

/** The launch the capture starts after, in the captured 2.1.280 background-shell shape. */
const LAUNCH: CapturedFrame[] = [
  {
    at: -30_000,
    frame: spawn(
      'toolu_bg_sleep',
      'Bash',
      { command: 'sleep 600', description: DESCRIPTION, run_in_background: true },
      null
    )
  },
  {
    at: -29_990,
    frame: system('background_tasks_changed', {
      tasks: [{ task_id: TASK, task_type: 'local_bash', description: DESCRIPTION }]
    })
  },
  {
    at: -29_990,
    frame: system('task_started', {
      task_id: TASK,
      tool_use_id: 'toolu_bg_sleep',
      description: DESCRIPTION,
      is_backgrounded: true,
      task_type: 'local_bash'
    })
  },
  { at: -29_980, frame: toolResult('toolu_bg_sleep', 'Command running in background', null) },
  { at: -28_000, frame: result('success') },
  { at: -28_000, frame: system('session_state_changed', { state: 'idle' }) }
]

describe('a real Claude Stop of a background shell, with a /clear waiting on it', () => {
  it('never owes the stopped task’s ending, and frees the /clear once the CLI idles', async () => {
    const capture = loadStopCapture()
    expect(capture.request).toEqual({ subtype: 'stop_task', task_id: TASK })
    const host = hostWithParent()
    const run = await producer(host)
    run.replay(LAUNCH)
    const records = () => host.getStructuredChildWorkViews(parent)
    const turnStates = () =>
      [...run.journalItems.values()].flatMap(({ body }) => {
        const turn = readAgentJournalTurn(body)
        return turn ? [turn.state] : []
      })
    const clearWaits = () =>
      queuedClearWait(
        null,
        records(),
        run.adapter.backgroundTaskStops('session-1'),
        run.adapter.stoppedTaskEndingOwed('session-1')
      )
    expect(records()).toMatchObject([{ membership: 'live', stoppable: true, providerId: TASK }])
    expect(clearWaits()).toBe('background-tasks')

    // The CLI writes the roster drop and the task's own ending, then answers the Stop.
    const owedSamples: boolean[] = []
    run.claude.routes.stop_task = () => {
      for (const captured of capture.beforeAnswer) {
        run.replay([captured])
        owedSamples.push(run.adapter.stoppedTaskEndingOwed('session-1'))
      }
    }
    const outcome = await run.adapter.stopBackgroundTasks({
      sessionId: 'session-1',
      fence: 7,
      taskIds: agentChildWorkStopTargets(records(), TASK)
    })
    expect(outcome).toEqual({ cancelled: true })
    expect(capture.beforeAnswer.map(({ frame }) => frame.subtype)).toEqual([
      'background_tasks_changed',
      'task_updated',
      'task_notification'
    ])
    owedSamples.push(run.adapter.stoppedTaskEndingOwed('session-1'))
    expect(owedSamples).toEqual([false, false, false, false])
    // The task reads stopped by its own ending, so the /clear no longer waits on background tasks.
    expect(records()).toMatchObject([
      { membership: 'settled', outcome: 'cancelled', providerId: TASK }
    ])
    expect(clearWaits()).toBeNull()
    // The ending opens the turn answering it, which the queue waits out before the /clear runs.
    expect(turnStates()).toEqual(['completed', 'running'])

    run.replay(capture.afterAnswer)
    expect(run.adapter.stoppedTaskEndingOwed('session-1')).toBe(false)
    expect(clearWaits()).toBeNull()
    // The CLI's idle completes it, so the clear's close cuts no turn: no interrupted-response line.
    expect(turnStates()).toEqual(['completed', 'completed'])
  })
})
