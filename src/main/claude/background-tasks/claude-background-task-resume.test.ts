import { describe, expect, it } from 'vitest'
import { ClaudeBackgroundTaskTracker } from './claude-background-task-tracker'

const agent = {
  task_id: 'a962f88aa82feb1c1',
  task_type: 'local_agent',
  description: 'Long proof writer'
}
const shell = { task_id: 'bcl6x3ixf', task_type: 'local_bash', description: 'sleep 150' }
const sibling = { task_id: 'sibling', task_type: 'local_agent' }

function system(subtype: string, fields: Record<string, unknown>) {
  return { type: 'system', subtype, ...fields }
}

describe('Claude background task pause/resume ownership', () => {
  it('moves a retained child back to live ownership across eviction, outcome, and auto-resume', () => {
    let now = 100
    const tracker = new ClaudeBackgroundTaskTracker(() => now)
    const roster = (tasks: unknown[]) =>
      tracker.observe(system('background_tasks_changed', { tasks }))
    roster([agent, sibling, shell])
    tracker.observe(
      system('task_progress', { task_id: agent.task_id, usage: { total_tokens: 18000 } })
    )
    tracker.observe({ type: 'result' })
    expect(tracker.state?.tasks).toHaveLength(3)
    roster([sibling, shell])
    expect(tracker.state?.settledTasks).toBeUndefined()
    tracker.observe(
      system('task_updated', { task_id: agent.task_id, patch: { status: 'completed' } })
    )
    tracker.observe(
      system('task_notification', {
        task_id: agent.task_id,
        status: 'completed',
        usage: { total_tokens: 19003 }
      })
    )
    expect(tracker.state?.settledTasks).toEqual([
      expect.objectContaining({
        id: agent.task_id,
        state: 'done',
        startedAt: 100,
        totalTokens: 19003
      })
    ])
    now = 150000
    roster([agent, sibling, shell])
    expect(tracker.state?.settledTasks).toBeUndefined()
    expect(tracker.state?.tasks).toEqual([
      expect.objectContaining({
        id: agent.task_id,
        state: 'working',
        startedAt: 100,
        totalTokens: 19003
      }),
      expect.objectContaining({ id: sibling.task_id }),
      expect.objectContaining({ id: shell.task_id })
    ])
    expect(tracker.stoppableTaskIds).toEqual([agent.task_id, sibling.task_id, shell.task_id])
    roster([sibling, shell])
    tracker.observe(
      system('task_notification', {
        task_id: agent.task_id,
        status: 'completed',
        usage: { total_tokens: 21000 }
      })
    )
    expect(tracker.state?.settledTasks).toEqual([
      expect.objectContaining({ id: agent.task_id, startedAt: 100, totalTokens: 21000 })
    ])
    roster([])
    expect(tracker.state).toBeNull()
  })

  it('reconciles an edge-only resume without keeping its earlier settled copy', () => {
    const tracker = new ClaudeBackgroundTaskTracker(() => 100)
    for (const task of [agent, sibling]) {
      tracker.observe(system('task_started', { ...task, is_backgrounded: true }))
    }
    tracker.observe(system('task_notification', { task_id: agent.task_id, status: 'completed' }))
    tracker.observe(
      system('task_updated', {
        task_id: agent.task_id,
        patch: { status: 'running', is_backgrounded: true }
      })
    )
    expect(tracker.state?.tasks).toHaveLength(2)
    expect(tracker.state?.settledTasks).toBeUndefined()
  })
})
