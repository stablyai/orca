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

describe('ClaudeBackgroundTaskTracker', () => {
  it('classifies SDK task types without inferring them from descriptions', () => {
    expect(classifyClaudeBackgroundTaskKind('local_agent')).toBe('agent')
    expect(classifyClaudeBackgroundTaskKind('local_workflow')).toBe('workflow')
    expect(classifyClaudeBackgroundTaskKind('local_bash')).toBe('command')
    expect(classifyClaudeBackgroundTaskKind('monitor')).toBe('monitor')
    expect(classifyClaudeBackgroundTaskKind('future_task')).toBe('unknown')
  })

  it('waits for the foreground turn to settle before monitoring a background task', () => {
    const tracker = new ClaudeBackgroundTaskTracker()
    tracker.observe({ type: 'user' }, true)
    tracker.observe(
      system('task_started', {
        task_id: 'task-1',
        task_type: 'local_agent',
        is_backgrounded: true
      })
    )
    expect(tracker.state).toBeNull()

    expect(tracker.observe(result())).toBe(true)
    expect(tracker.state).toEqual({
      state: 'monitoring',
      tasks: [{ id: 'task-1', kind: 'agent' }]
    })
  })

  it('uses an explicit background update for a foreground task and ignores progress alone', () => {
    const tracker = new ClaudeBackgroundTaskTracker()
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
      tasks: [{ id: 'task-1', kind: 'command' }]
    })
  })

  it('publishes bounded display details when a running task description changes', () => {
    const tracker = new ClaudeBackgroundTaskTracker()
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
      tasks: [{ id: 'task-1', kind: 'command', description: 'run the build' }]
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

  it('replaces its roster from aggregate lifecycle frames and preserves stoppable provider ids', () => {
    const tracker = new ClaudeBackgroundTaskTracker()
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
        { id: 'task-agent', kind: 'agent', description: 'agent' },
        { id: 'task-bash', kind: 'command', description: 'bash' }
      ]
    })

    expect(
      tracker.observe(
        aggregate([{ task_id: 'task-next', task_type: 'local_workflow', description: 'workflow' }])
      )
    ).toBe(true)
    expect(tracker.stoppableTaskIds).toEqual(['task-next'])
    expect(tracker.state).toEqual({
      state: 'monitoring',
      tasks: [{ id: 'task-next', kind: 'workflow', description: 'workflow' }]
    })

    expect(tracker.observe(aggregate([]))).toBe(true)
    expect(tracker.stoppableTaskIds).toEqual([])
    expect(tracker.state).toBeNull()
  })

  it('excludes ambient aggregate tasks', () => {
    const tracker = new ClaudeBackgroundTaskTracker()
    tracker.observe(
      aggregate([
        { task_id: 'ambient', task_type: 'monitor', description: 'watcher', ambient: true },
        { task_id: 'visible', task_type: 'local_bash', description: 'command' }
      ])
    )

    expect(tracker.stoppableTaskIds).toEqual(['visible'])
  })

  it('does not let late edge frames revive tasks cleared by an aggregate roster', () => {
    const tracker = new ClaudeBackgroundTaskTracker()
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
    const tracker = new ClaudeBackgroundTaskTracker()
    tracker.observe(system('task_notification', { task_id: 'task-live', status: 'completed' }))

    tracker.observe(
      aggregate([{ task_id: 'task-live', task_type: 'local_agent', description: 'agent' }])
    )

    expect(tracker.stoppableTaskIds).toEqual(['task-live'])
    expect(tracker.state).toEqual({
      state: 'monitoring',
      tasks: [{ id: 'task-live', kind: 'agent', description: 'agent' }]
    })
  })

  it('keeps terminal edges authoritative on either side of aggregate replacement', () => {
    const terminalFirst = new ClaudeBackgroundTaskTracker()
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

    const terminalLast = new ClaudeBackgroundTaskTracker()
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
    const tracker = new ClaudeBackgroundTaskTracker()
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
      tasks: [{ id: 'task-live', kind: 'monitor' }]
    })
    expect(
      tracker.observe(system('task_updated', { task_id: 'task-live', patch: { status: 'killed' } }))
    ).toBe(true)
    expect(tracker.state).toBeNull()
  })

  it('recognizes task types that are registered only as background work', () => {
    for (const taskType of ['local_workflow', 'monitor']) {
      const tracker = new ClaudeBackgroundTaskTracker()
      tracker.observe(system('task_started', { task_id: taskType, task_type: taskType }))
      expect(tracker.state).toEqual({
        state: 'monitoring',
        tasks: [{ id: taskType, kind: taskType === 'local_workflow' ? 'workflow' : 'monitor' }]
      })
    }
  })

  it('admits unknown background updates conservatively and bounds edge-only fallback ids', () => {
    const tracker = new ClaudeBackgroundTaskTracker()
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
    expect(tracker.stoppableTaskIds.length).toBeLessThanOrEqual(256)
  })

  it('bounds aggregate rosters and resets to the edge-only fallback on clear', () => {
    const tracker = new ClaudeBackgroundTaskTracker()
    tracker.observe(
      aggregate(
        Array.from({ length: 400 }, (_, index) => ({
          task_id: `aggregate-${index}`,
          task_type: 'local_bash',
          description: 'command'
        }))
      )
    )
    expect(tracker.stoppableTaskIds).toHaveLength(256)

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

  it('gates aggregate monitoring behind foreground turn completion', () => {
    const tracker = new ClaudeBackgroundTaskTracker()
    tracker.observe({ type: 'user' }, true)
    tracker.observe(
      aggregate([{ task_id: 'task-live', task_type: 'local_bash', description: 'command' }])
    )
    expect(tracker.state).toBeNull()

    expect(tracker.observe(result())).toBe(true)
    expect(tracker.state).toEqual({
      state: 'monitoring',
      tasks: [{ id: 'task-live', kind: 'command', description: 'command' }]
    })
  })

  it('ignores ambient SDK tasks and clears all liveness when the session ends', () => {
    const tracker = new ClaudeBackgroundTaskTracker()
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
})
