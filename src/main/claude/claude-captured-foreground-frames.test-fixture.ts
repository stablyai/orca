// Claude CLI 2.1.280 stream-json captures, cut to the frames and fields the child-work path reads.
// Ids, paths and prompts are replaced; the frame order and the relative clock (`at`, ms after the
// first user message) are the captured ones.

import {
  result,
  spawn,
  system,
  toolResult,
  type CapturedFrame
} from './claude-captured-frame-builders.test-fixture'

const interruptedAgentStart = (at: number, toolUseId: string): CapturedFrame[] => [
  {
    at,
    frame: spawn(toolUseId, 'Agent', { description: 'Run sleep command and report' }, null)
  },
  {
    at: at + 16,
    frame: system('task_started', {
      task_id: 'agent-1',
      tool_use_id: toolUseId,
      description: 'Run sleep command and report',
      subagent_type: 'general-purpose',
      is_backgrounded: false,
      task_type: 'local_agent'
    })
  },
  {
    at: at + 4_357,
    frame: system('task_progress', {
      task_id: 'agent-1',
      tool_use_id: toolUseId,
      usage: { total_tokens: 18_844, tool_uses: 1, duration_ms: 4_342 },
      last_tool_name: 'Bash'
    })
  }
]

const REJECTED = "The user doesn't want to proceed with this tool use. The tool use was rejected."

/** An interrupt while the foreground agent sits between tools: its own stop comes first. */
export const INTERRUPTED_BETWEEN_TOOLS: CapturedFrame[] = [
  ...interruptedAgentStart(5_000, 'toolu_agent'),
  {
    at: 11_019,
    frame: system('task_updated', { task_id: 'agent-1', patch: { status: 'killed' } })
  },
  {
    at: 11_019,
    frame: system('task_notification', {
      task_id: 'agent-1',
      tool_use_id: 'toolu_agent',
      status: 'stopped',
      summary: 'Run sleep command and report'
    })
  },
  { at: 11_020, frame: toolResult('toolu_agent', REJECTED, null, true) },
  { at: 11_026, frame: result('error_during_execution') }
]

/** An interrupt while the foreground agent's own shell runs: the spawn result precedes its stop. */
export const INTERRUPTED_IN_OWN_SHELL: CapturedFrame[] = [
  ...interruptedAgentStart(2_876, 'toolu_agent'),
  {
    at: 6_317,
    frame: spawn('toolu_shell', 'Bash', { command: 'sleep 45; echo 1' }, 'toolu_agent')
  },
  {
    at: 9_424,
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
    at: 11_321,
    frame: system('task_notification', {
      task_id: 'shell-1',
      tool_use_id: 'toolu_shell',
      status: 'stopped',
      summary: 'Sleep 45 seconds then print 1'
    })
  },
  { at: 11_324, frame: toolResult('toolu_agent', REJECTED, null, true) },
  {
    at: 11_325,
    frame: system('task_updated', { task_id: 'agent-1', patch: { status: 'killed' } })
  },
  {
    at: 11_325,
    frame: system('task_notification', {
      task_id: 'agent-1',
      tool_use_id: 'toolu_agent',
      status: 'stopped',
      summary: 'Run sleep command and report'
    })
  },
  { at: 11_328, frame: result('error_during_execution') }
]

/** A foreground agent that finishes: its own ending, then its summary, then the spawn result. */
export const FOREGROUND_SUCCESS: CapturedFrame[] = [
  { at: 3_695, frame: spawn('toolu_agent', 'Agent', { description: 'Run echo hi command' }, null) },
  {
    at: 3_709,
    frame: system('task_started', {
      task_id: 'agent-1',
      tool_use_id: 'toolu_agent',
      description: 'Run echo hi command',
      subagent_type: 'general-purpose',
      is_backgrounded: false,
      task_type: 'local_agent'
    })
  },
  {
    at: 5_501,
    frame: system('task_progress', {
      task_id: 'agent-1',
      tool_use_id: 'toolu_agent',
      usage: { total_tokens: 14_576, tool_uses: 1, duration_ms: 1_792 },
      last_tool_name: 'Bash'
    })
  },
  { at: 5_505, frame: spawn('toolu_echo', 'Bash', { command: 'echo hi' }, 'toolu_agent') },
  { at: 5_652, frame: toolResult('toolu_echo', 'hi', 'toolu_agent', false) },
  {
    at: 7_101,
    frame: system('task_updated', { task_id: 'agent-1', patch: { status: 'completed' } })
  },
  {
    at: 7_101,
    frame: system('task_notification', {
      task_id: 'agent-1',
      tool_use_id: 'toolu_agent',
      status: 'completed',
      summary: 'The command executed successfully. Output: `hi`',
      usage: { total_tokens: 16_908, tool_uses: 1, duration_ms: 3_393 }
    })
  },
  { at: 7_113, frame: toolResult('toolu_agent', 'hi', null) },
  { at: 8_952, frame: result('success') }
]
