// Claude streams nothing while a forked slash command runs, so its SDK hooks stand in for the
// missing messages; the CLI's own batch at the end rewrites the same tool rows.

import { randomUUID } from 'node:crypto'
import type { HookCallback, HookInput, Options } from '@anthropic-ai/claude-agent-sdk'
import type { ClaudeReadingBarrier } from '../sdk-transport/claude-reading-barrier'
import { claudeRecord } from '../structured/journal/claude-structured-item-translation'
import { isClaudeForkedCommandTask } from './claude-subagent-task-frames'

type ForkedRun = {
  parentRef: string
  succeeded: Set<string>
  report?: string
}

export type ClaudeForkedCommandLiveFrames = {
  hooks: NonNullable<Options['hooks']>
  /** Pass every stream message through; a fork's ending comes back carrying its report. */
  observe: (message: Record<string, unknown>) => Record<string, unknown>
}

const toolUse = (id: string, name: string, input: unknown) => ({
  type: 'tool_use',
  id,
  name,
  input
})

// Only shell tools report text here; other tools' output waits for the batch.
function shellOutput(response: unknown): string {
  const shell = claudeRecord(response)
  return shell && shell.isImage !== true
    ? [shell.stdout, shell.stderr]
        .filter((text) => typeof text === 'string' && text !== '')
        .join('\n')
    : ''
}

export function createClaudeForkedCommandLiveFrames(
  emit: (message: Record<string, unknown>) => void,
  reading: Pick<ClaudeReadingBarrier, 'isPaused' | 'waitUntilReadable'>
): ClaudeForkedCommandLiveFrames {
  const runs = new Map<string, ForkedRun>()
  // Hooks skip the stream reader, so they wait here for it to read on and to name their fork.
  const held = new Map<string, HookInput[]>()

  const emitAs = (
    agentId: string,
    run: ForkedRun,
    sessionId: string,
    role: 'assistant' | 'user',
    content: Record<string, unknown>[]
  ): void =>
    emit({
      type: role,
      message: { role, content },
      uuid: randomUUID(),
      session_id: sessionId,
      parent_tool_use_id: run.parentRef,
      agent_id: agentId
    })

  const apply = (agentId: string, run: ForkedRun, input: HookInput): void => {
    const say = (role: 'assistant' | 'user', content: Record<string, unknown>[]): void =>
      emitAs(agentId, run, input.session_id, role, content)
    const result = (toolUseId: string, content: unknown, isError: boolean) => ({
      type: 'tool_result',
      tool_use_id: toolUseId,
      content,
      is_error: isError
    })
    if (input.hook_event_name === 'PreToolUse') {
      say('assistant', [toolUse(input.tool_use_id, input.tool_name, input.tool_input)])
    } else if (input.hook_event_name === 'PostToolUse') {
      run.succeeded.add(input.tool_use_id)
      // Settles the row now; the batch rewrites it with the text Claude saw.
      say('user', [result(input.tool_use_id, shellOutput(input.tool_response), false)])
    } else if (input.hook_event_name === 'PostToolUseFailure') {
      say('user', [result(input.tool_use_id, input.error, true)])
    } else if (input.hook_event_name === 'PostToolBatch') {
      // A result closes its call, so name each call again before rewriting its result.
      say(
        'assistant',
        input.tool_calls.map((call) => toolUse(call.tool_use_id, call.tool_name, call.tool_input))
      )
      // The only hook that also reports denied and blocked calls.
      say(
        'user',
        input.tool_calls.map((call) =>
          result(call.tool_use_id, call.tool_response ?? '', !run.succeeded.has(call.tool_use_id))
        )
      )
    } else if (input.hook_event_name === 'SubagentStop') {
      run.report = input.last_assistant_message?.trim()
      if (run.report) {
        say('assistant', [{ type: 'text', text: run.report }])
      }
    }
  }

  const release = (agentId: string, evenIfPaused = false): void => {
    const run = runs.get(agentId)
    const queue = held.get(agentId)
    if (!run || !queue) {
      return
    }
    while (queue.length > 0 && (evenIfPaused || !reading.isPaused())) {
      apply(agentId, run, queue.shift()!)
    }
    if (queue.length === 0) {
      held.delete(agentId)
    } else {
      releaseWhenReadable(agentId)
    }
  }

  const releaseWhenReadable = (agentId: string): void =>
    void reading.waitUntilReadable().then(() => release(agentId))

  const callback: HookCallback = async (input) => {
    const agentId = input.agent_id
    // While paused the stream may not have named the fork yet, so keep any agent's hooks.
    if (agentId && (runs.has(agentId) || held.has(agentId) || reading.isPaused())) {
      held.set(agentId, [...(held.get(agentId) ?? []), input])
      release(agentId)
    }
    return {}
  }
  const matchers = [{ hooks: [callback] }]

  return {
    hooks: {
      PreToolUse: matchers,
      PostToolUse: matchers,
      PostToolUseFailure: matchers,
      PostToolBatch: matchers,
      SubagentStop: matchers
    },
    observe: (message) => {
      const agentId = message.task_id
      if (message.type !== 'system' || typeof agentId !== 'string') {
        return message
      }
      if (message.subtype === 'task_started') {
        if (isClaudeForkedCommandTask(message)) {
          const name = String(message.description).slice(1).split(' ')[0]
          runs.set(agentId, { parentRef: `forked-command-${name}`, succeeded: new Set() })
          // Runs after the caller delivers this start.
          releaseWhenReadable(agentId)
        } else {
          held.delete(agentId)
        }
        return message
      }
      if (message.subtype !== 'task_notification') {
        return message
      }
      // The fork's calls and report must precede its ending.
      release(agentId, true)
      held.delete(agentId)
      const report = runs.get(agentId)?.report
      runs.delete(agentId)
      return report ? { ...message, last_assistant_message: report } : message
    }
  }
}
