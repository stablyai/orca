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
  child = CHILD,
  name = 'count_a'
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
        agentPath: `/root/${name}`
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

function command(
  threadId = PRIMARY,
  method = 'item/started',
  commandText = 'sleep 90'
): CodexBackgroundTaskEvent {
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
        command: commandText,
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

  it('reports an executing child while the spawning turn is still open', () => {
    const tracker = runningChild()
    const running = {
      state: 'monitoring',
      supportsStopAll: false,
      tasks: [{ id: `codex-agent:${CHILD}`, kind: 'agent', description: 'count_a' }]
    }
    // The strip is a live view: a fan-out is reported while it runs, not once
    // the parent turn happens to end.
    expect(tracker.state).toEqual(running)
    // Turn end reveals children, it never settles them; the child is unchanged.
    expect(tracker.observe(turn('turn/completed', PRIMARY, PARENT_TURN))).toBe(false)
    expect(tracker.state).toEqual(running)
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
  it('keeps a primary shell visible from launch until its own completion', () => {
    const tracker = new CodexBackgroundTaskTracker(PRIMARY)
    const shell = [{ id: 'codex-command:primary:exec-1', kind: 'command', description: 'sleep 90' }]
    tracker.observe(turn('turn/started', PRIMARY, PARENT_TURN))
    tracker.observe(command())
    // Visible while the turn that launched it is still running.
    expect(tracker.state?.tasks).toEqual(shell)
    tracker.observe(turn('turn/completed', PRIMARY, PARENT_TURN))
    expect(tracker.state?.tasks).toEqual(shell)
    // Only the shell's own completion retires the row.
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

  it('keeps the command visible under a label that would otherwise fill the row', () => {
    const tracker = new CodexBackgroundTaskTracker(PRIMARY)
    tracker.observe(turn('turn/started', PRIMARY, PARENT_TURN))
    tracker.observe(turn('turn/started', CHILD, CHILD_TURN))
    tracker.observe(activity('started', PARENT_TURN, CHILD, 'L'.repeat(600)))
    tracker.observe(command(CHILD))
    tracker.observe(turn('turn/completed', PRIMARY, PARENT_TURN))
    tracker.observe(turn('turn/completed', CHILD, CHILD_TURN))
    const description = tracker.state?.tasks?.[0]?.description
    expect(description).toContain('sleep 90')
    expect(description).toBe(`${'L'.repeat(95)}… — sleep 90`)
  })

  it('never cuts a label mid surrogate pair', () => {
    const tracker = new CodexBackgroundTaskTracker(PRIMARY)
    tracker.observe(turn('turn/started', PRIMARY, PARENT_TURN))
    tracker.observe(turn('turn/started', CHILD, CHILD_TURN))
    tracker.observe(activity('started', PARENT_TURN, CHILD, `${'L'.repeat(94)}\u{1F600}bad`))
    tracker.observe(command(CHILD))
    tracker.observe(turn('turn/completed', PRIMARY, PARENT_TURN))
    tracker.observe(turn('turn/completed', CHILD, CHILD_TURN))
    const description = tracker.state?.tasks?.[0]?.description ?? ''
    expect(description.isWellFormed()).toBe(true)
    expect(description).toBe(`${'L'.repeat(94)}… — sleep 90`)
  })

  it('never cuts a qualified command mid surrogate pair', () => {
    // The label is bounded, then the COMPOSED row is bounded again. That second
    // cut lands inside the description, so clipping only the label side leaves a
    // lone surrogate — lossy through any non-JSON UTF-8 hop.
    const tracker = new CodexBackgroundTaskTracker(PRIMARY)
    tracker.observe(turn('turn/started', PRIMARY, PARENT_TURN))
    tracker.observe(turn('turn/started', CHILD, CHILD_TURN))
    tracker.observe(activity('started', PARENT_TURN, CHILD, 'L'.repeat(96)))
    // Places the pair exactly where a raw slice of the composed row splits it.
    tracker.observe(command(CHILD, 'item/started', `${'C'.repeat(412)}\u{1F600}${'D'.repeat(200)}`))
    tracker.observe(turn('turn/completed', PRIMARY, PARENT_TURN))
    tracker.observe(turn('turn/completed', CHILD, CHILD_TURN))
    const description = tracker.state?.tasks?.[0]?.description ?? ''
    expect(description.length).toBeLessThanOrEqual(512)
    expect(description.startsWith(`${'L'.repeat(96)} — `)).toBe(true)
    expect(description.isWellFormed()).toBe(true)
  })

  it('never cuts an unqualified primary command mid surrogate pair', () => {
    const tracker = new CodexBackgroundTaskTracker(PRIMARY)
    tracker.observe(turn('turn/started', PRIMARY, PARENT_TURN))
    // The pair straddles the raw description bound itself.
    tracker.observe(
      command(PRIMARY, 'item/started', `${'C'.repeat(511)}\u{1F600}${'D'.repeat(50)}`)
    )
    tracker.observe(turn('turn/completed', PRIMARY, PARENT_TURN))
    const description = tracker.state?.tasks?.[0]?.description ?? ''
    expect(description.length).toBeLessThanOrEqual(512)
    expect(description.isWellFormed()).toBe(true)
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
