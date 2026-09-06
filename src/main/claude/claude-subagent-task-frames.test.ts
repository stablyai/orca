import { describe, expect, it } from 'vitest'
import { readClaudeSubagentTaskFrame } from './claude-subagent-task-frames'

function system(subtype: string, fields: Record<string, unknown>): Record<string, unknown> {
  return { type: 'system', subtype, session_id: 'claude-session', ...fields }
}

describe('readClaudeSubagentTaskFrame', () => {
  it('ignores frames that are not task frames', () => {
    expect(readClaudeSubagentTaskFrame({ type: 'assistant', subtype: 'task_started' })).toBeNull()
    expect(readClaudeSubagentTaskFrame(system('init', { task_id: 'task-1' }))).toBeNull()
    expect(readClaudeSubagentTaskFrame(system('task_started', {}))).toBeNull()
    expect(readClaudeSubagentTaskFrame(system('task_started', { task_id: '' }))).toBeNull()
  })

  describe('task_type triage', () => {
    it('announces a local_agent task', () => {
      const frame = readClaudeSubagentTaskFrame(
        system('task_started', {
          task_id: 'task-1',
          tool_use_id: 'toolu_1',
          task_type: 'local_agent',
          subagent_type: 'code-reviewer',
          description: 'Review the diff'
        })
      )
      expect(frame).toMatchObject({
        taskId: 'task-1',
        toolUseId: 'toolu_1',
        label: 'Review the diff',
        announcesSubagent: true,
        excluded: false
      })
    })

    it('excludes a backgrounded shell command even though it carries a tool_use_id', () => {
      const frame = readClaudeSubagentTaskFrame(
        system('task_started', {
          task_id: 'task-bash',
          tool_use_id: 'toolu_bash',
          task_type: 'local_bash',
          description: 'sleep 20',
          is_backgrounded: true
        })
      )
      expect(frame).toMatchObject({
        taskId: 'task-bash',
        toolUseId: 'toolu_bash',
        announcesSubagent: false,
        excluded: true
      })
    })

    it('excludes workflows and monitors', () => {
      for (const taskType of ['local_workflow', 'monitor']) {
        expect(
          readClaudeSubagentTaskFrame(
            system('task_started', { task_id: `task-${taskType}`, task_type: taskType })
          )
        ).toMatchObject({ announcesSubagent: false, excluded: true })
      }
    })

    it('caps a subagent_type label the way a description is capped', () => {
      const frame = readClaudeSubagentTaskFrame(
        system('task_started', { task_id: 'task-1', subagent_type: 'a'.repeat(900) })
      )
      // The roster stores this label verbatim, so nothing downstream bounds it.
      expect(frame?.label).toHaveLength(512)
    })

    it('falls back to subagent_type only when the release sends no task_type', () => {
      expect(
        readClaudeSubagentTaskFrame(
          system('task_started', { task_id: 'task-old', subagent_type: 'explorer' })
        )
      ).toMatchObject({ announcesSubagent: true, label: 'explorer' })
      expect(
        readClaudeSubagentTaskFrame(system('task_started', { task_id: 'task-bare' }))
      ).toMatchObject({ announcesSubagent: false, excluded: true })
      // A type this build does not recognise is not an agent on subagent_type's word.
      expect(
        readClaudeSubagentTaskFrame(
          system('task_started', {
            task_id: 'task-new',
            task_type: 'local_something_new',
            subagent_type: 'explorer'
          })
        )
      ).toMatchObject({ announcesSubagent: false, excluded: true })
    })

    it('excludes ambient housekeeping tasks', () => {
      for (const suppression of [{ skip_transcript: true }, { ambient: true }]) {
        expect(
          readClaudeSubagentTaskFrame(
            system('task_started', {
              task_id: 'task-ambient',
              task_type: 'local_agent',
              subagent_type: 'watcher',
              ...suppression
            })
          )
        ).toMatchObject({ announcesSubagent: false, excluded: true })
      }
    })
  })

  describe('status', () => {
    it('collapses every in-flight status to working', () => {
      for (const status of ['pending', 'running', 'paused']) {
        expect(
          readClaudeSubagentTaskFrame(
            system('task_updated', { task_id: 'task-1', patch: { status } })
          )
        ).toMatchObject({ state: 'working' })
      }
    })

    it('maps the settled statuses onto the carrier vocabulary', () => {
      const mapped: [string, string][] = [
        ['completed', 'completed'],
        ['failed', 'failed'],
        ['killed', 'stopped'],
        ['stopped', 'stopped']
      ]
      for (const [status, state] of mapped) {
        expect(
          readClaudeSubagentTaskFrame(
            system('task_updated', { task_id: 'task-1', patch: { status } })
          )
        ).toMatchObject({ state })
      }
    })

    it('reports no state for a status it cannot map', () => {
      for (const status of ['__proto__', 'toString', 'invented', 7, null]) {
        expect(
          readClaudeSubagentTaskFrame(
            system('task_updated', { task_id: 'task-1', patch: { status } })
          )
        ).toMatchObject({ state: null })
      }
    })

    it('treats progress and notification as no lifecycle verdict', () => {
      for (const subtype of ['task_progress', 'task_notification']) {
        expect(
          readClaudeSubagentTaskFrame(
            system(subtype, { task_id: 'task-1', status: 'completed', patch: { status: 'failed' } })
          )
        ).toMatchObject({ state: null })
      }
    })
  })

  it('reads the backgrounded flag from the frame or its patch', () => {
    expect(
      readClaudeSubagentTaskFrame(
        system('task_started', {
          task_id: 'task-1',
          task_type: 'local_agent',
          is_backgrounded: true
        })
      )
    ).toMatchObject({ backgrounded: true })
    expect(
      readClaudeSubagentTaskFrame(
        system('task_updated', { task_id: 'task-1', patch: { is_backgrounded: true } })
      )
    ).toMatchObject({ backgrounded: true })
    expect(
      readClaudeSubagentTaskFrame(system('task_updated', { task_id: 'task-1', patch: {} }))
    ).toMatchObject({ backgrounded: false })
  })

  it('collapses a multi-line description into one bounded label', () => {
    expect(
      readClaudeSubagentTaskFrame(
        system('task_updated', {
          task_id: 'task-1',
          patch: { description: '  audit\n  the   lockfile  ' }
        })
      )
    ).toMatchObject({ label: 'audit the lockfile' })
  })
})
