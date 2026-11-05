import { describe, expect, it } from 'vitest'
import {
  ClaudeBackgroundTaskTracker,
  classifyClaudeBackgroundTaskKind
} from './claude-background-task-tracker'

function system(subtype: string, fields: Record<string, unknown>): Record<string, unknown> {
  return { type: 'system', subtype, session_id: 'provider-1', uuid: crypto.randomUUID(), ...fields }
}

function result(): Record<string, unknown> {
  return { type: 'result', subtype: 'success', session_id: 'provider-1', uuid: crypto.randomUUID() }
}

function aggregate(tasks: unknown[]): Record<string, unknown> {
  return system('background_tasks_changed', { tasks })
}

function trackerAt(times: number[]): ClaudeBackgroundTaskTracker {
  let index = 0
  return new ClaudeBackgroundTaskTracker(() => times[Math.min(index++, times.length - 1)])
}

function rows(tracker: ClaudeBackgroundTaskTracker): { id: string; stoppable?: boolean }[] {
  return (tracker.state?.tasks ?? []).map((task) => ({
    id: task.id,
    ...(task.stoppable === undefined ? {} : { stoppable: task.stoppable })
  }))
}

function started(id: string, backgrounded: boolean): Record<string, unknown> {
  return system('task_started', {
    task_id: id,
    task_type: 'local_agent',
    is_backgrounded: backgrounded
  })
}

describe('ClaudeBackgroundTaskTracker', () => {
  it('classifies SDK task types without inferring them from descriptions', () => {
    expect(classifyClaudeBackgroundTaskKind('local_agent')).toBe('agent')
    expect(classifyClaudeBackgroundTaskKind('local_workflow')).toBe('workflow')
    expect(classifyClaudeBackgroundTaskKind('local_bash')).toBe('command')
    expect(classifyClaudeBackgroundTaskKind('monitor')).toBe('monitor')
    expect(classifyClaudeBackgroundTaskKind('future_task')).toBe('unknown')
  })

  it('publishes a backgrounded task while the foreground turn is still running', () => {
    const tracker = trackerAt([100])
    tracker.observe({ type: 'user' }, true)
    expect(
      tracker.observe(
        system('task_started', {
          task_id: 'task-1',
          task_type: 'local_agent',
          is_backgrounded: true
        })
      )
    ).toBe(true)
    expect(tracker.state).toEqual({
      state: 'monitoring',
      tasks: [{ id: 'task-1', kind: 'agent', state: 'working', startedAt: 100 }]
    })

    expect(tracker.observe(result())).toBe(false)
    expect(tracker.state?.tasks).toHaveLength(1)
  })

  it('uses an explicit background update for a foreground task and ignores progress alone', () => {
    const tracker = trackerAt([100])
    tracker.observe({ type: 'user' }, true)
    tracker.observe(
      system('task_started', {
        task_id: 'task-1',
        task_type: 'local_bash',
        is_backgrounded: false
      })
    )
    expect(
      tracker.observe(system('task_progress', { task_id: 'task-1', description: 'still working' }))
    ).toBe(false)
    tracker.observe(result())
    expect(tracker.state).toBeNull()

    tracker.observe(system('task_updated', { task_id: 'task-1', patch: { is_backgrounded: true } }))
    expect(tracker.state).toEqual({
      state: 'monitoring',
      tasks: [{ id: 'task-1', kind: 'command', state: 'working', startedAt: 100 }]
    })
  })

  it('publishes bounded display details when a running task description changes', () => {
    const tracker = trackerAt([100])
    expect(
      tracker.observe(
        system('task_started', {
          task_id: 'task-1',
          task_type: 'local_bash',
          is_backgrounded: true,
          description: '  run\n  the build  '
        })
      )
    ).toBe(true)
    expect(tracker.state).toEqual({
      state: 'monitoring',
      tasks: [
        {
          id: 'task-1',
          kind: 'command',
          description: 'run the build',
          state: 'working',
          startedAt: 100
        }
      ]
    })

    expect(
      tracker.observe(
        system('task_updated', {
          task_id: 'task-1',
          patch: { description: 'x'.repeat(600) }
        })
      )
    ).toBe(true)
    expect(tracker.state?.tasks?.[0]?.description).toHaveLength(512)
    expect(
      tracker.observe(
        system('task_updated', {
          task_id: 'task-1',
          patch: { description: 'x'.repeat(600) }
        })
      )
    ).toBe(false)
  })

  it('carries provider-reported names and re-derives classification per transition', () => {
    const tracker = trackerAt([100])
    tracker.observe(
      system('task_started', {
        task_id: 'task-1',
        task_type: 'future_task',
        is_backgrounded: true
      })
    )
    expect(tracker.state?.tasks?.[0]).toMatchObject({ kind: 'unknown' })

    expect(
      tracker.observe(
        system('task_updated', {
          task_id: 'task-1',
          patch: { task_type: 'local_agent', agent_type: 'deep_review' }
        })
      )
    ).toBe(true)
    expect(tracker.state?.tasks?.[0]).toMatchObject({
      kind: 'agent',
      name: 'deep_review',
      state: 'working'
    })
  })

  it('retains settled siblings beside live work and exits with the last live task', () => {
    const tracker = trackerAt([100, 200])
    tracker.observe(
      system('task_started', { task_id: 'task-a', task_type: 'local_agent', is_backgrounded: true })
    )
    tracker.observe(
      system('task_started', { task_id: 'task-b', task_type: 'local_agent', is_backgrounded: true })
    )

    expect(
      tracker.observe(system('task_updated', { task_id: 'task-a', patch: { status: 'completed' } }))
    ).toBe(true)
    expect(tracker.state).toEqual({
      state: 'monitoring',
      tasks: [{ id: 'task-b', kind: 'agent', state: 'working', startedAt: 200 }],
      settledTasks: [{ id: 'task-a', kind: 'agent', state: 'done', startedAt: 100 }]
    })
    expect(tracker.stoppableTaskIds).toEqual(['task-b'])

    expect(
      tracker.observe(system('task_updated', { task_id: 'task-b', patch: { status: 'killed' } }))
    ).toBe(true)
    expect(tracker.state).toBeNull()
  })

  it('settles a sibling from the captured producer order: aggregate eviction, then the outcome', () => {
    // Captured SDK order: roster removal precedes terminal edges.
    const tracker = trackerAt([100, 200])
    tracker.observe(
      system('task_started', {
        task_id: 'bh4zn8der',
        tool_use_id: 'toolu_01M',
        description: 'Sleep for 5 seconds',
        is_backgrounded: true,
        task_type: 'local_bash'
      })
    )
    tracker.observe(
      aggregate([
        { task_id: 'bh4zn8der', task_type: 'local_bash', description: 'Sleep for 5 seconds' },
        { task_id: 'bprosaiim', task_type: 'local_bash', description: 'Sleep for 25 seconds' }
      ])
    )

    tracker.observe(
      aggregate([
        { task_id: 'bprosaiim', task_type: 'local_bash', description: 'Sleep for 25 seconds' }
      ])
    )
    tracker.observe(
      system('task_updated', {
        task_id: 'bh4zn8der',
        patch: { status: 'completed', end_time: 1788804376515 }
      })
    )
    expect(
      tracker.observe(
        system('task_notification', {
          task_id: 'bh4zn8der',
          tool_use_id: 'toolu_01M',
          status: 'completed',
          summary: 'Background command "Sleep for 5 seconds" completed (exit code 0)',
          usage: { total_tokens: 18130, tool_uses: 1, duration_ms: 10772 }
        })
      )
    ).toBe(true)
    expect(tracker.state).toEqual({
      state: 'monitoring',
      tasks: [
        {
          id: 'bprosaiim',
          kind: 'command',
          description: 'Sleep for 25 seconds',
          state: 'working',
          startedAt: 200
        }
      ],
      settledTasks: [
        {
          id: 'bh4zn8der',
          kind: 'command',
          description: 'Sleep for 5 seconds',
          state: 'done',
          startedAt: 100,
          totalTokens: 18130
        }
      ]
    })

    tracker.observe(aggregate([]))
    tracker.observe(system('task_updated', { task_id: 'bprosaiim', patch: { status: 'killed' } }))
    tracker.observe(system('task_notification', { task_id: 'bprosaiim', status: 'stopped' }))
    expect(tracker.state).toBeNull()
  })

  it('carries task_progress usage into a live row without clobbering its name', () => {
    const tracker = trackerAt([100])
    tracker.observe(
      system('task_started', {
        task_id: 'agent-1',
        task_type: 'local_agent',
        subagent_type: 'general-purpose',
        description: 'Sleep 6 seconds test',
        is_backgrounded: true
      })
    )
    expect(
      tracker.observe(
        system('task_progress', {
          task_id: 'agent-1',
          description: 'Running Sleep for 6 seconds',
          subagent_type: 'general-purpose',
          usage: { total_tokens: 14866, tool_uses: 1, duration_ms: 2818 },
          last_tool_name: 'Bash'
        })
      )
    ).toBe(true)
    expect(tracker.state?.tasks?.[0]).toEqual({
      id: 'agent-1',
      kind: 'agent',
      description: 'Sleep 6 seconds test',
      name: 'general-purpose',
      state: 'working',
      startedAt: 100,
      totalTokens: 14866
    })
  })

  it('maps terminal statuses onto settled states', () => {
    const tracker = trackerAt([100, 200])
    tracker.observe(
      system('task_started', { task_id: 'live', task_type: 'local_agent', is_backgrounded: true })
    )
    tracker.observe(
      system('task_started', { task_id: 'failed', task_type: 'local_agent', is_backgrounded: true })
    )
    tracker.observe(system('task_notification', { task_id: 'failed', status: 'failed' }))
    expect(tracker.state?.settledTasks).toEqual([
      { id: 'failed', kind: 'agent', state: 'blocked', startedAt: 200 }
    ])
  })

  it('leaves a task open when a patch cannot be read', () => {
    const tracker = trackerAt([100])
    tracker.observe(
      system('task_started', { task_id: 'task-1', task_type: 'local_agent', is_backgrounded: true })
    )
    expect(tracker.observe(system('task_updated', { task_id: 'task-1', patch: 'garbage' }))).toBe(
      false
    )
    expect(tracker.state?.tasks).toHaveLength(1)
    expect(tracker.state?.settledTasks).toBeUndefined()
  })

  it('replaces its roster from aggregate lifecycle frames and preserves stoppable provider ids', () => {
    const tracker = trackerAt([100])
    expect(
      tracker.observe(
        aggregate([
          { task_id: 'task-agent', task_type: 'local_agent', description: 'agent' },
          { task_id: 'task-bash', task_type: 'local_bash', description: 'bash' }
        ])
      )
    ).toBe(true)
    expect(tracker.stoppableTaskIds).toEqual(['task-agent', 'task-bash'])
    expect(tracker.state).toEqual({
      state: 'monitoring',
      tasks: [
        { id: 'task-agent', kind: 'agent', description: 'agent', state: 'working', startedAt: 100 },
        { id: 'task-bash', kind: 'command', description: 'bash', state: 'working', startedAt: 100 }
      ]
    })

    expect(
      tracker.observe(
        aggregate([{ task_id: 'task-next', task_type: 'local_workflow', description: 'workflow' }])
      )
    ).toBe(true)
    expect(tracker.stoppableTaskIds).toEqual(['task-next'])

    expect(tracker.observe(aggregate([]))).toBe(true)
    expect(tracker.stoppableTaskIds).toEqual([])
    expect(tracker.state).toBeNull()
  })

  it('preserves first-seen timestamps across aggregate roster replacement', () => {
    const tracker = trackerAt([100, 200])
    tracker.observe(
      system('task_started', { task_id: 'task-1', task_type: 'local_agent', is_backgrounded: true })
    )
    tracker.observe(
      aggregate([
        { task_id: 'task-1', task_type: 'local_agent' },
        { task_id: 'task-2', task_type: 'local_bash' }
      ])
    )
    expect(tracker.state?.tasks).toEqual([
      { id: 'task-1', kind: 'agent', state: 'working', startedAt: 100 },
      { id: 'task-2', kind: 'command', state: 'working', startedAt: 200 }
    ])
  })

  it('excludes ambient aggregate tasks', () => {
    const tracker = trackerAt([100])
    tracker.observe(
      aggregate([
        { task_id: 'ambient', task_type: 'monitor', description: 'watcher', ambient: true },
        { task_id: 'visible', task_type: 'local_bash', description: 'command' }
      ])
    )

    expect(tracker.stoppableTaskIds).toEqual(['visible'])
  })

  it('does not let late edge frames revive tasks cleared by an aggregate roster', () => {
    const tracker = trackerAt([100])
    tracker.observe(
      aggregate([{ task_id: 'task-late', task_type: 'local_agent', description: 'agent' }])
    )
    tracker.observe(aggregate([]))

    tracker.observe(
      system('task_started', {
        task_id: 'task-late',
        task_type: 'local_agent',
        is_backgrounded: true
      })
    )
    tracker.observe(
      system('task_updated', { task_id: 'task-late', patch: { is_backgrounded: true } })
    )

    expect(tracker.stoppableTaskIds).toEqual([])
    expect(tracker.state).toBeNull()
  })

  it('lets an authoritative aggregate roster replace earlier terminal-edge evidence', () => {
    const tracker = trackerAt([100])
    tracker.observe(system('task_notification', { task_id: 'task-live', status: 'completed' }))

    tracker.observe(
      aggregate([{ task_id: 'task-live', task_type: 'local_agent', description: 'agent' }])
    )

    expect(tracker.stoppableTaskIds).toEqual(['task-live'])
    expect(tracker.state).toEqual({
      state: 'monitoring',
      tasks: [
        { id: 'task-live', kind: 'agent', description: 'agent', state: 'working', startedAt: 100 }
      ]
    })
  })

  it('retracts a settled copy when an authoritative roster reports the task live again', () => {
    const tracker = trackerAt([100, 200, 300])
    const tasks = [
      { task_id: 'agent', task_type: 'local_agent', description: 'Review sample' },
      { task_id: 'shell', task_type: 'local_bash' }
    ]
    tracker.observe(aggregate(tasks))
    tracker.observe(system('task_notification', { task_id: 'agent', status: 'completed' }))
    expect(tracker.state?.settledTasks).toHaveLength(1)
    tracker.observe(aggregate(tasks))
    expect(tracker.state?.tasks?.map((task) => task.id)).toEqual(['agent', 'shell'])
    expect(tracker.state?.settledTasks).toBeUndefined()
  })

  it('keeps terminal edges authoritative on either side of aggregate replacement', () => {
    const terminalFirst = trackerAt([100])
    terminalFirst.observe(
      system('task_notification', { task_id: 'task-first', status: 'completed' })
    )
    terminalFirst.observe(aggregate([]))
    terminalFirst.observe(
      system('task_started', {
        task_id: 'task-first',
        task_type: 'local_agent',
        is_backgrounded: true
      })
    )
    expect(terminalFirst.state).toBeNull()

    const terminalLast = trackerAt([100])
    terminalLast.observe(
      aggregate([{ task_id: 'task-last', task_type: 'local_agent', description: 'agent' }])
    )
    terminalLast.observe(system('task_notification', { task_id: 'task-last', status: 'completed' }))
    terminalLast.observe(
      system('task_started', {
        task_id: 'task-last',
        task_type: 'local_agent',
        is_backgrounded: true
      })
    )
    expect(terminalLast.state).toBeNull()
  })

  it('keeps terminal evidence authoritative across duplicates and out-of-order starts', () => {
    const tracker = trackerAt([100])
    const terminal = system('task_notification', { task_id: 'task-late', status: 'completed' })
    tracker.observe(terminal)
    tracker.observe(terminal)
    tracker.observe(
      system('task_started', {
        task_id: 'task-late',
        task_type: 'local_workflow',
        is_backgrounded: true
      })
    )
    expect(tracker.state).toBeNull()

    tracker.observe(
      system('task_started', {
        task_id: 'task-live',
        task_type: 'monitor'
      })
    )
    expect(tracker.state).toEqual({
      state: 'monitoring',
      tasks: [{ id: 'task-live', kind: 'monitor', state: 'monitoring', startedAt: 100 }]
    })
    expect(
      tracker.observe(system('task_updated', { task_id: 'task-live', patch: { status: 'killed' } }))
    ).toBe(true)
    expect(tracker.state).toBeNull()
  })

  it('recognizes task types that are registered only as background work', () => {
    for (const taskType of ['local_workflow', 'monitor']) {
      const tracker = trackerAt([100])
      tracker.observe(system('task_started', { task_id: taskType, task_type: taskType }))
      expect(tracker.state).toEqual({
        state: 'monitoring',
        tasks: [
          {
            id: taskType,
            kind: taskType === 'local_workflow' ? 'workflow' : 'monitor',
            state: taskType === 'local_workflow' ? 'working' : 'monitoring',
            startedAt: 100
          }
        ]
      })
    }
  })

  it('admits unknown background updates conservatively and tracks every edge-only start', () => {
    const tracker = trackerAt([100])
    tracker.observe(
      system('task_updated', { task_id: 'unknown', patch: { is_backgrounded: true } })
    )
    expect(tracker.stoppableTaskIds).toEqual(['unknown'])

    for (let index = 0; index < 400; index += 1) {
      tracker.observe(
        system('task_started', {
          task_id: `task-${index}`,
          task_type: 'local_agent',
          is_backgrounded: true
        })
      )
    }
    expect(tracker.stoppableTaskIds).toHaveLength(401)
    tracker.observe(system('task_notification', { task_id: 'unknown', status: 'completed' }))
    for (let index = 0; index < 399; index += 1) {
      tracker.observe(
        system('task_notification', { task_id: `task-${index}`, status: 'completed' })
      )
    }
    expect(tracker.goalBackgroundWork).toBe('live')
    tracker.observe(system('task_notification', { task_id: 'task-399', status: 'completed' }))
    expect(tracker.goalBackgroundWork).toBe('exited')
  })

  it('lists every aggregate roster entry and resets to the edge-only fallback on clear', () => {
    const tracker = trackerAt([100])
    tracker.observe(
      aggregate(
        Array.from({ length: 400 }, (_, index) => ({
          task_id: `aggregate-${index}`,
          task_type: 'local_bash',
          description: 'command'
        }))
      )
    )
    expect(tracker.stoppableTaskIds).toHaveLength(400)

    tracker.clear()
    tracker.observe(
      system('task_started', {
        task_id: 'edge-after-reset',
        task_type: 'local_agent',
        is_backgrounded: true
      })
    )
    expect(tracker.stoppableTaskIds).toEqual(['edge-after-reset'])
  })

  it('publishes an aggregate roster observed mid-turn', () => {
    const tracker = trackerAt([100])
    tracker.observe({ type: 'user' }, true)
    expect(
      tracker.observe(
        aggregate([{ task_id: 'task-live', task_type: 'local_bash', description: 'command' }])
      )
    ).toBe(true)
    expect(tracker.state).toEqual({
      state: 'monitoring',
      tasks: [
        {
          id: 'task-live',
          kind: 'command',
          description: 'command',
          state: 'working',
          startedAt: 100
        }
      ]
    })
  })

  it('ignores ambient SDK tasks and clears all liveness when the session ends', () => {
    const tracker = trackerAt([100])
    tracker.observe(
      system('task_started', {
        task_id: 'ambient',
        task_type: 'monitor',
        is_backgrounded: true,
        ambient: true
      })
    )
    expect(tracker.state).toBeNull()
    tracker.observe(
      system('task_started', {
        task_id: 'task-live',
        task_type: 'local_agent',
        is_backgrounded: true
      })
    )
    expect(tracker.clear()).toBe(true)
    expect(tracker.state).toBeNull()
  })
  it('marks a foreground row not stoppable and leaves a backgrounded row alone', () => {
    const tracker = new ClaudeBackgroundTaskTracker()
    tracker.observe({ type: 'user' }, true)
    tracker.observe(started('fore-1', false))
    tracker.observe(started('back-1', true))

    expect(rows(tracker)).toEqual([{ id: 'fore-1', stoppable: false }, { id: 'back-1' }])
    expect(tracker.stoppableTaskIds).toEqual(['back-1'])
  })

  it('keeps live foreground work across an aggregate roster that never lists it', () => {
    const tracker = new ClaudeBackgroundTaskTracker()
    tracker.observe({ type: 'user' }, true)
    tracker.observe(started('fore-1', false))
    tracker.observe(
      aggregate([{ task_id: 'back-1', task_type: 'local_bash', description: 'bash' }])
    )

    expect(rows(tracker)).toEqual([{ id: 'fore-1', stoppable: false }, { id: 'back-1' }])

    tracker.observe(started('fore-2', false))
    expect(rows(tracker)).toEqual([
      { id: 'fore-1', stoppable: false },
      { id: 'back-1' },
      { id: 'fore-2', stoppable: false }
    ])

    tracker.observe(result())
    expect(rows(tracker)).toEqual([{ id: 'back-1' }])
  })

  it('drops a stale backgrounded start and retains every live foreground row', () => {
    const tracker = new ClaudeBackgroundTaskTracker()
    tracker.observe({ type: 'user' }, true)
    for (let index = 0; index < 300; index += 1) {
      tracker.observe(started(`fore-${index}`, false))
    }
    tracker.observe(
      aggregate([{ task_id: 'back-1', task_type: 'local_bash', description: 'bash' }])
    )

    const ids = rows(tracker).map((row) => row.id)
    expect(ids).toHaveLength(301)
    expect(ids).toContain('fore-0')
    expect(ids).toContain('back-1')

    tracker.observe(started('stale', true))
    expect(tracker.stoppableTaskIds).toEqual(['back-1'])
  })

  it('keeps a finished foreground id dead across a roster that never listed it', () => {
    const tracker = new ClaudeBackgroundTaskTracker()
    tracker.observe({ type: 'user' }, true)
    tracker.observe(started('fore-1', false))
    tracker.observe(system('task_notification', { task_id: 'fore-1', status: 'completed' }))
    expect(tracker.state).toBeNull()

    tracker.observe(
      aggregate([{ task_id: 'back-1', task_type: 'local_bash', description: 'bash' }])
    )
    tracker.observe(started('fore-1', false))

    expect(rows(tracker)).toEqual([{ id: 'back-1' }])
  })

  it('retires a phantom foreground row when the next turn starts', () => {
    const tracker = new ClaudeBackgroundTaskTracker()
    tracker.observe(started('phantom', false))
    expect(rows(tracker)).toEqual([{ id: 'phantom', stoppable: false }])

    tracker.observe({ type: 'user' }, true)
    expect(tracker.state).toBeNull()
  })

  it('settles a previous turn the way the subagent roster settles it', () => {
    const tracker = new ClaudeBackgroundTaskTracker()
    tracker.observe({ type: 'user' }, true)
    tracker.observe(started('fore', false))
    tracker.observe(started('back', true))

    tracker.observe({ type: 'user' }, true)
    expect(rows(tracker)).toEqual([{ id: 'back' }])
  })

  it('empties only between one task retiring and the next starting', () => {
    const tracker = new ClaudeBackgroundTaskTracker()
    tracker.observe({ type: 'user' }, true)
    tracker.observe(started('A', false))
    expect(rows(tracker)).toEqual([{ id: 'A', stoppable: false }])
    tracker.observe(system('task_notification', { task_id: 'A', status: 'completed' }))
    expect(tracker.state).toBeNull()
    tracker.observe(started('B', false))
    expect(rows(tracker)).toEqual([{ id: 'B', stoppable: false }])

    const spanned = new ClaudeBackgroundTaskTracker()
    spanned.observe({ type: 'user' }, true)
    spanned.observe(started('bg', true))
    spanned.observe(started('A', false))
    spanned.observe(system('task_notification', { task_id: 'A', status: 'completed' }))
    expect(rows(spanned)).toEqual([{ id: 'bg' }])
  })
})
