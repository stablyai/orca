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
        announcesSubagent: true,
        excluded: false
      })
    })

    it('announces the legacy local_subagent task type', () => {
      expect(
        readClaudeSubagentTaskFrame(
          system('task_started', {
            task_id: 'task-legacy-subagent',
            tool_use_id: 'toolu_legacy',
            task_type: 'local_subagent',
            subagent_type: 'code-reviewer',
            description: 'Review the diff'
          })
        )
      ).toMatchObject({ announcesSubagent: true, excluded: false })
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

    it('falls back to subagent_type only when the release sends no task_type', () => {
      expect(
        readClaudeSubagentTaskFrame(
          system('task_started', { task_id: 'task-old', subagent_type: 'explorer' })
        )
      ).toMatchObject({ announcesSubagent: true })
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

  it('reads the spawn call id from an update patch', () => {
    expect(
      readClaudeSubagentTaskFrame(
        system('task_updated', { task_id: 'task-1', patch: { tool_use_id: 'toolu_1' } })
      )
    ).toMatchObject({ taskId: 'task-1', toolUseId: 'toolu_1', excluded: false })
  })
})
