// CLI 2.1.280 capture: sanitized IDs/prompts; original frame order and spawn-relative times.

import {
  result,
  says,
  spawn,
  system,
  toolResult,
  type CapturedFrame
} from './claude-captured-frame-builders.test-fixture'

/** Shell completion resumes the same agent under its original spawn call. */
export const WAKES_AFTER_ITS_SHELL: CapturedFrame[] = [
  {
    at: 0,
    frame: spawn(
      'toolu_agent',
      'Agent',
      { description: 'Sleep 40 seconds then reply', run_in_background: true },
      null
    )
  },
  {
    at: 15,
    frame: system('task_started', {
      task_id: 'agent-1',
      tool_use_id: 'toolu_agent',
      description: 'Sleep 40 seconds then reply',
      subagent_type: 'general-purpose',
      is_backgrounded: true,
      task_type: 'local_agent'
    })
  },
  { at: 30, frame: toolResult('toolu_agent', 'Async agent launched successfully.', null) },
  { at: 1_944, frame: result('success') },
  {
    at: 4_343,
    frame: spawn(
      'toolu_shell',
      'Bash',
      {
        command: 'sleep 40',
        description: 'Wait 40 seconds in background',
        run_in_background: true
      },
      'toolu_agent'
    )
  },
  {
    at: 4_431,
    frame: system('task_started', {
      task_id: 'shell-1',
      owned_by_subagent: true,
      tool_use_id: 'toolu_shell',
      description: 'Wait 40 seconds in background',
      is_backgrounded: true,
      task_type: 'local_bash'
    })
  },
  {
    at: 4_441,
    frame: toolResult(
      'toolu_shell',
      'Command running in background with ID: shell-1.',
      'toolu_agent'
    )
  },
  {
    at: 11_913,
    frame: system('task_updated', { task_id: 'agent-1', patch: { status: 'completed' } })
  },
  {
    at: 11_913,
    frame: system('task_notification', {
      task_id: 'agent-1',
      tool_use_id: 'toolu_agent',
      status: 'completed',
      summary: '`sleep 40` is still running in the background.',
      usage: { total_tokens: 17_928, tool_uses: 2, duration_ms: 11_901 }
    })
  },
  {
    at: 44_454,
    frame: system('task_updated', { task_id: 'shell-1', patch: { status: 'completed' } })
  },
  {
    at: 44_454,
    frame: system('task_notification', {
      task_id: 'shell-1',
      tool_use_id: 'toolu_shell',
      status: 'completed',
      summary: 'Background command "Wait 40 seconds in background" completed (exit code 0)'
    })
  },
  {
    at: 44_460,
    frame: system('task_started', {
      task_id: 'agent-1',
      tool_use_id: 'toolu_agent',
      description: 'Sleep 40 seconds then reply',
      subagent_type: 'general-purpose',
      is_backgrounded: true,
      task_type: 'local_agent'
    })
  },
  { at: 46_198, frame: says('agent-1-final', 'DONE', 'toolu_agent') },
  {
    at: 46_198,
    frame: system('task_updated', { task_id: 'agent-1', patch: { status: 'completed' } })
  },
  {
    at: 46_199,
    frame: system('task_notification', {
      task_id: 'agent-1',
      tool_use_id: 'toolu_agent',
      status: 'completed',
      summary: 'DONE',
      usage: { total_tokens: 18_181, tool_uses: 2, duration_ms: 46_184 }
    })
  }
]
