// Claude CLI 2.1.280 stream-json captures, cut to the frames and fields the child-work path reads.
// Ids, paths and prompts are replaced; the frame order and the relative clock (`at`, ms after the
// first user message) are the captured ones.

import {
  result,
  says,
  spawn,
  system,
  toolResult,
  type CapturedFrame
} from './claude-captured-frame-builders.test-fixture'

/** A foreground agent runs a 45 s shell; the user moves the agent to the background mid-run.
 *  The parent's turn ends at +12,610 ms while the agent's own shell runs until +51,275 ms. */
export const MOVED_TO_BACKGROUND: CapturedFrame[] = [
  {
    at: 3_259,
    frame: spawn(
      'toolu_agent',
      'Agent',
      { description: 'Run 45s sleep command', run_in_background: false },
      null
    )
  },
  {
    at: 3_275,
    frame: system('task_started', {
      task_id: 'agent-1',
      tool_use_id: 'toolu_agent',
      description: 'Run 45s sleep command',
      subagent_type: 'general-purpose',
      is_backgrounded: false,
      task_type: 'local_agent'
    })
  },
  {
    at: 6_126,
    frame: system('task_progress', {
      task_id: 'agent-1',
      tool_use_id: 'toolu_agent',
      description: 'Running Sleep 45 seconds then print 1',
      usage: { total_tokens: 18_837, tool_uses: 1, duration_ms: 2_852 },
      last_tool_name: 'Bash'
    })
  },
  {
    at: 6_127,
    frame: spawn(
      'toolu_shell',
      'Bash',
      { command: 'sleep 45; echo 1', description: 'Sleep 45 seconds then print 1' },
      'toolu_agent'
    )
  },
  {
    at: 9_249,
    frame: system('task_started', {
      task_id: 'shell-1',
      owned_by_subagent: true,
      tool_use_id: 'toolu_shell',
      description: 'Sleep 45 seconds then print 1',
      is_backgrounded: false,
      task_type: 'local_bash'
    })
  },
  {
    at: 11_128,
    frame: system('background_tasks_changed', {
      tasks: [
        { task_id: 'agent-1', task_type: 'local_agent', description: 'Run 45s sleep command' }
      ]
    })
  },
  {
    at: 11_128,
    frame: system('task_updated', { task_id: 'agent-1', patch: { is_backgrounded: true } })
  },
  {
    at: 11_139,
    frame: toolResult('toolu_agent', 'Async agent launched successfully.', null)
  },
  { at: 12_563, frame: says('parent-1', 'The agent has been launched.', null) },
  { at: 12_610, frame: result('success') },
  {
    at: 51_275,
    frame: system('task_notification', {
      task_id: 'shell-1',
      tool_use_id: 'toolu_shell',
      status: 'completed',
      summary: 'Sleep 45 seconds then print 1'
    })
  },
  { at: 51_292, frame: toolResult('toolu_shell', '1', 'toolu_agent', false) },
  { at: 52_398, frame: says('agent-1-final', 'Exact stdout: `1`', 'toolu_agent') },
  { at: 52_441, frame: system('background_tasks_changed', { tasks: [] }) },
  {
    at: 52_441,
    frame: system('task_updated', { task_id: 'agent-1', patch: { status: 'completed' } })
  },
  {
    at: 52_441,
    frame: system('task_notification', {
      task_id: 'agent-1',
      tool_use_id: 'toolu_agent',
      status: 'completed',
      summary: 'The command completed after ~45 seconds. Exact stdout: `1`',
      usage: { total_tokens: 22_160, tool_uses: 1, duration_ms: 49_167 }
    })
  },
  { at: 54_303, frame: says('parent-2', 'The agent ran the command.', null) },
  { at: 54_450, frame: result('success') }
]

/** A background agent finishes; the next turn asks Claude to message it, which resumes it. The
 *  revived run starts again under the message call, after a roster that lists it. */
export const RESUMED_BY_MESSAGE: CapturedFrame[] = [
  {
    at: 3_279,
    frame: spawn(
      'toolu_agent',
      'Agent',
      { description: 'Run echo first-run command', run_in_background: true },
      null
    )
  },
  {
    at: 3_320,
    frame: system('background_tasks_changed', {
      tasks: [
        { task_id: 'agent-1', task_type: 'local_agent', description: 'Run echo first-run command' }
      ]
    })
  },
  {
    at: 3_322,
    frame: system('task_started', {
      task_id: 'agent-1',
      tool_use_id: 'toolu_agent',
      description: 'Run echo first-run command',
      subagent_type: 'general-purpose',
      is_backgrounded: true,
      task_type: 'local_agent'
    })
  },
  { at: 3_349, frame: toolResult('toolu_agent', 'Async agent launched successfully.', null) },
  { at: 4_765, frame: result('success') },
  {
    at: 5_077,
    frame: system('task_progress', {
      task_id: 'agent-1',
      tool_use_id: 'toolu_agent',
      usage: { total_tokens: 13_615, tool_uses: 1, duration_ms: 1_759 },
      last_tool_name: 'Bash'
    })
  },
  { at: 7_427, frame: system('background_tasks_changed', { tasks: [] }) },
  {
    at: 7_427,
    frame: system('task_updated', { task_id: 'agent-1', patch: { status: 'completed' } })
  },
  {
    at: 7_427,
    frame: system('task_notification', {
      task_id: 'agent-1',
      tool_use_id: 'toolu_agent',
      status: 'completed',
      summary: 'The command executed successfully. Output: `first-run`',
      usage: { total_tokens: 15_971, tool_uses: 1, duration_ms: 4_110 }
    })
  },
  { at: 10_960, frame: result('success') },
  {
    at: 16_118,
    frame: spawn(
      'toolu_message',
      'SendMessage',
      { to: 'agent-1', message: 'Run echo second-run and report.' },
      null
    )
  },
  {
    at: 16_142,
    frame: system('background_tasks_changed', {
      tasks: [
        { task_id: 'agent-1', task_type: 'local_agent', description: 'Run echo first-run command' }
      ]
    })
  },
  {
    at: 16_143,
    frame: system('task_started', {
      task_id: 'agent-1',
      tool_use_id: 'toolu_message',
      description: 'Run echo first-run command',
      subagent_type: 'general-purpose',
      is_backgrounded: true,
      task_type: 'local_agent'
    })
  },
  { at: 16_166, frame: toolResult('toolu_message', '{"success":true}', null) },
  { at: 17_420, frame: result('success') },
  {
    at: 17_889,
    frame: system('task_progress', {
      task_id: 'agent-1',
      tool_use_id: 'toolu_message',
      usage: { total_tokens: 16_064, tool_uses: 2, duration_ms: 14_568 },
      last_tool_name: 'Bash'
    })
  },
  { at: 19_568, frame: system('background_tasks_changed', { tasks: [] }) },
  {
    at: 19_568,
    frame: system('task_updated', { task_id: 'agent-1', patch: { status: 'completed' } })
  },
  {
    at: 19_568,
    frame: system('task_notification', {
      task_id: 'agent-1',
      tool_use_id: 'toolu_message',
      status: 'completed',
      summary: 'The command executed successfully. Output: `second-run`',
      usage: { total_tokens: 16_259, tool_uses: 2, duration_ms: 16_249 }
    })
  },
  { at: 20_956, frame: result('success') }
]
