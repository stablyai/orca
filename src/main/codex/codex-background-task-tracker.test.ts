import { describe, expect, it } from 'vitest'
import { CodexBackgroundTaskTracker } from './codex-background-task-tracker'
import {
  readCodexBackgroundTaskFrame,
  type CodexBackgroundTaskEvent
} from './codex-background-task-frames'

const PRIMARY = 'parent-thread'
const PARENT_TURN = 'parent-turn'
const CHILD = 'child-thread'
const CHILD_TURN = 'child-turn'

function turn(
  method: 'turn/started' | 'turn/completed',
  threadId: string,
  turnId: string,
  status = 'completed'
): CodexBackgroundTaskEvent {
  return { method, threadId, params: { threadId, turn: { id: turnId, status } } }
}

function activity(
  kind = 'started',
  parentTurn = PARENT_TURN,
  child = CHILD
): CodexBackgroundTaskEvent {
  return {
    method: 'item/started',
    threadId: PRIMARY,
    params: {
      threadId: PRIMARY,
      turnId: parentTurn,
      item: {
        type: 'subAgentActivity',
        id: `activity-${kind}`,
        kind,
        agentThreadId: child,
        agentPath: '/root/count_a'
      }
    }
  }
}

function runningChild(): CodexBackgroundTaskTracker {
  const tracker = new CodexBackgroundTaskTracker(PRIMARY)
  tracker.observe(turn('turn/started', PRIMARY, PARENT_TURN))
  tracker.observe(turn('turn/started', CHILD, CHILD_TURN))
  tracker.observe(activity())
  return tracker
}

function command(threadId = PRIMARY, method = 'item/started'): CodexBackgroundTaskEvent {
  return {
    method,
    threadId,
    params: {
      threadId,
      turnId: PARENT_TURN,
      item: {
        type: 'commandExecution',
        id: 'exec-1',
        processId: '71831',
        source: 'unifiedExecStartup',
        command: 'sleep 90',
        status: method === 'item/started' ? 'inProgress' : 'completed'
      }
    }
  }
}

describe('readCodexBackgroundTaskFrame', () => {
  it('reads activity as child metadata without inferring execution state', () => {
    expect(readCodexBackgroundTaskFrame(activity('interacted'), PRIMARY)).toEqual({
      kind: 'subagent',
      agentThreadId: CHILD,
      label: 'count_a',
      parentTurnId: PARENT_TURN
    })
  })

  it('reads a child turn with its own execution identity', () => {
    expect(readCodexBackgroundTaskFrame(turn('turn/started', CHILD, CHILD_TURN), PRIMARY)).toEqual({
      kind: 'turn',
      threadId: CHILD,
      turnId: CHILD_TURN,
      state: 'working'
    })
  })

  it('does not register the primary thread even when its activity path is missing', () => {
    const event = activity('interacted', PARENT_TURN, PRIMARY)
    ;(event.params as { item: { agentPath?: string } }).item.agentPath = undefined
    expect(readCodexBackgroundTaskFrame(event, PRIMARY)).toBeNull()
  })
})

describe('CodexBackgroundTaskTracker child execution ownership', () => {
  it('does not claim work from an activity item without a child turn', () => {
    const tracker = new CodexBackgroundTaskTracker(PRIMARY)
    tracker.observe(activity())
    tracker.observe(activity('interacted'))
    tracker.observe(turn('turn/completed', PRIMARY, PARENT_TURN))
    expect(tracker.state).toBeNull()
  })

  it('reports an executing child only after the foreground turn ends', () => {
    const tracker = runningChild()
    expect(tracker.state).toBeNull()
    expect(tracker.observe(turn('turn/completed', PRIMARY, PARENT_TURN))).toBe(true)
    expect(tracker.state).toEqual({
      state: 'monitoring',
      supportsStopAll: false,
      tasks: [{ id: `codex-agent:${CHILD}`, kind: 'agent', description: 'count_a' }]
    })
  })

  it('never settles a child when a primary turn ends', () => {
    const tracker = runningChild()
    tracker.observe(turn('turn/completed', PRIMARY, PARENT_TURN))
    for (let index = 0; index < 300; index++) {
      expect(tracker.observe(turn('turn/completed', PRIMARY, `later-${index}`))).toBe(false)
    }
    expect(tracker.state?.tasks).toHaveLength(1)
  })

  it.each(['completed', 'interrupted', 'failed'])(
    'settles on the matching child turn %s',
    (status) => {
      const tracker = runningChild()
      tracker.observe(turn('turn/completed', PRIMARY, PARENT_TURN))
      expect(tracker.observe(turn('turn/completed', CHILD, CHILD_TURN, status))).toBe(true)
      expect(tracker.state).toBeNull()
    }
  )

  it('does not mistake late activity completion for the current child execution', () => {
    const tracker = runningChild()
    tracker.observe(turn('turn/completed', PRIMARY, PARENT_TURN))
    tracker.observe(activity('completed'))
    expect(tracker.state?.tasks).toHaveLength(1)
  })

  it.each([PARENT_TURN, 'followup-parent'])(
    'reports follow-up work in %s using the new child turn',
    (parentTurn) => {
      const tracker = runningChild()
      tracker.observe(turn('turn/completed', CHILD, CHILD_TURN))
      tracker.observe(turn('turn/completed', PRIMARY, PARENT_TURN))
      tracker.observe(turn('turn/started', PRIMARY, parentTurn))
      tracker.observe(activity('interacted', parentTurn))
      expect(tracker.state).toBeNull()
      tracker.observe(turn('turn/started', CHILD, 'followup-child-turn'))
      tracker.observe(turn('turn/completed', PRIMARY, parentTurn))
      expect(tracker.state?.tasks).toHaveLength(1)
      tracker.observe(turn('turn/completed', CHILD, CHILD_TURN))
      tracker.observe(turn('turn/started', CHILD, CHILD_TURN))
      tracker.observe(activity('completed'))
      expect(tracker.state?.tasks).toHaveLength(1)
      tracker.observe(turn('turn/completed', CHILD, 'followup-child-turn'))
      expect(tracker.state).toBeNull()
    }
  )

  it('keeps idle send_message activity out of the strip', () => {
    const tracker = runningChild()
    tracker.observe(turn('turn/completed', CHILD, CHILD_TURN))
    tracker.observe(turn('turn/completed', PRIMARY, PARENT_TURN))
    tracker.observe(activity('interacted', 'message-parent'))
    tracker.observe(turn('turn/completed', PRIMARY, 'message-parent'))
    expect(tracker.state).toBeNull()
  })

  it('does not invent another execution for a message to a working child', () => {
    const tracker = runningChild()
    tracker.observe(turn('turn/completed', PRIMARY, PARENT_TURN))
    tracker.observe(activity('interacted', 'message-parent'))
    tracker.observe(turn('turn/completed', PRIMARY, 'message-parent'))
    expect(tracker.state?.tasks).toHaveLength(1)
    tracker.observe(turn('turn/completed', CHILD, CHILD_TURN))
    expect(tracker.state).toBeNull()
  })

  it('retains completion delivered before child registration', () => {
    const tracker = new CodexBackgroundTaskTracker(PRIMARY)
    tracker.observe(turn('turn/started', CHILD, CHILD_TURN))
    tracker.observe(turn('turn/completed', CHILD, CHILD_TURN))
    tracker.observe(activity())
    tracker.observe(turn('turn/completed', PRIMARY, PARENT_TURN))
    expect(tracker.state).toBeNull()
  })

  it('publishes no extra state for duplicate owner or metadata events', () => {
    const tracker = runningChild()
    tracker.observe(turn('turn/completed', PRIMARY, PARENT_TURN))
    expect(tracker.observe(turn('turn/started', CHILD, CHILD_TURN))).toBe(false)
    expect(tracker.observe({ ...activity(), method: 'item/completed' })).toBe(false)
    expect(tracker.observe(turn('turn/completed', CHILD, CHILD_TURN))).toBe(true)
    expect(tracker.observe(turn('turn/completed', CHILD, CHILD_TURN))).toBe(false)
  })

  it('bounds retained child history while allowing repeated completed runs', () => {
    const tracker = new CodexBackgroundTaskTracker(PRIMARY)
    tracker.observe(activity())
    for (let index = 0; index < 300; index++) {
      const id = `child-turn-${index}`
      tracker.observe(turn('turn/started', CHILD, id))
      expect(tracker.state?.tasks).toHaveLength(1)
      tracker.observe(turn('turn/completed', CHILD, id))
      expect(tracker.state).toBeNull()
    }
  })

  it('clears the roster at session teardown', () => {
    const tracker = runningChild()
    tracker.observe(turn('turn/completed', PRIMARY, PARENT_TURN))
    expect(tracker.clear()).toBe(true)
    expect(tracker.state).toBeNull()
    expect(tracker.clear()).toBe(false)
  })
})

describe('CodexBackgroundTaskTracker command integration', () => {
  it('keeps a primary shell visible after the turn until its own completion', () => {
    const tracker = new CodexBackgroundTaskTracker(PRIMARY)
    tracker.observe(turn('turn/started', PRIMARY, PARENT_TURN))
    tracker.observe(command())
    expect(tracker.state).toBeNull()
    tracker.observe(turn('turn/completed', PRIMARY, PARENT_TURN))
    expect(tracker.state?.tasks).toEqual([
      { id: 'codex-command:primary:exec-1', kind: 'command', description: 'sleep 90' }
    ])
    tracker.observe(command(PRIMARY, 'item/completed'))
    expect(tracker.state).toBeNull()
  })

  it('reveals a child shell only after the child execution finishes', () => {
    const tracker = runningChild()
    tracker.observe(turn('turn/completed', PRIMARY, PARENT_TURN))
    tracker.observe(command(CHILD))
    expect(tracker.state?.tasks).toHaveLength(1)
    tracker.observe(turn('turn/completed', CHILD, CHILD_TURN, 'interrupted'))
    expect(tracker.state?.tasks).toEqual([
      {
        id: `codex-command:thread:${CHILD}:exec-1`,
        kind: 'command',
        description: 'count_a — sleep 90'
      }
    ])
    tracker.observe(command(CHILD, 'item/completed'))
    expect(tracker.state).toBeNull()
  })

  it('leaves a primary shell unqualified', () => {
    const tracker = runningChild()
    tracker.observe(command(PRIMARY))
    tracker.observe(turn('turn/completed', PRIMARY, PARENT_TURN))
    expect(tracker.state?.tasks).toContainEqual({
      id: 'codex-command:primary:exec-1',
      kind: 'command',
      description: 'sleep 90'
    })
  })

  it('names a child shell whose label only arrives after the command', () => {
    const tracker = new CodexBackgroundTaskTracker(PRIMARY)
    tracker.observe(turn('turn/started', PRIMARY, PARENT_TURN))
    tracker.observe(turn('turn/started', CHILD, CHILD_TURN))
    tracker.observe(command(CHILD))
    tracker.observe(turn('turn/completed', PRIMARY, PARENT_TURN))
    tracker.observe(activity())
    tracker.observe(turn('turn/completed', CHILD, CHILD_TURN))
    expect(tracker.state?.tasks).toEqual([
      {
        id: `codex-command:thread:${CHILD}:exec-1`,
        kind: 'command',
        description: 'count_a — sleep 90'
      }
    ])
  })
})
