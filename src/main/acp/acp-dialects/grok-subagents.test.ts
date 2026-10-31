import { describe, expect, it } from 'vitest'
import type { AgentJournalToolCallItem } from '../../../shared/agent-session-journal-types'
import type { ToolCallUpdate } from '../generated/acp-protocol.generated'
import { grokToolBackgroundTasks } from './grok-background-tasks'
import { GROK_ACP_DIALECT } from './grok-dialect'
import { grokSubagentNotification, grokToolSubagents } from './grok-subagents'

const SUBAGENT_RESULT_TAIL =
  '\n\n<subagent_meta>id=subagent-1, tool_calls=1, turns=1</subagent_meta>\n\n<subagent_result>\nsubagent_id: subagent-1\n</subagent_result>'

function tool(name: string, input: unknown = null): AgentJournalToolCallItem {
  return { kind: 'tool-call', callId: 'call-1', name, input, state: 'completed' }
}

function finished(update: Partial<ToolCallUpdate>): ToolCallUpdate {
  return { toolCallId: 'call-1', status: 'completed', ...update }
}

describe('Grok subagent session updates', () => {
  it('reads a spawn with its description, its spawning turn and nothing it cannot show', () => {
    expect(
      grokSubagentNotification({
        sessionUpdate: 'subagent_spawned',
        subagent_id: 'subagent-1',
        child_session_id: 'subagent-1',
        parent_prompt_id: 'prompt-1',
        subagent_type: 'general-purpose',
        description: 'Count note lines',
        model: 'grok-4.7'
      })
    ).toEqual({ id: 'subagent-1', state: 'working', label: 'Count note lines', turn: 'prompt-1' })
  })

  it('labels a spawn with no description by its type', () => {
    expect(
      grokSubagentNotification({
        sessionUpdate: 'subagent_spawned',
        subagent_id: 'subagent-1',
        subagent_type: 'explore'
      })
    ).toEqual({ id: 'subagent-1', state: 'working', label: 'explore' })
  })

  it('reads progress as tokens only', () => {
    expect(
      grokSubagentNotification({
        sessionUpdate: 'subagent_progress',
        subagent_id: 'subagent-1',
        tokens_used: 4091
      })
    ).toEqual({ id: 'subagent-1', tokens: 4091 })
  })

  it.each([
    ['completed', { state: 'completed', result: '4' }],
    ['failed', { state: 'failed' }],
    ['cancelled', { state: 'stopped' }],
    ['something-new', {}]
  ] as const)('reads a %s finish', (status, expected) => {
    expect(
      grokSubagentNotification({
        sessionUpdate: 'subagent_finished',
        subagent_id: 'subagent-1',
        status,
        output: status === 'completed' ? '4' : undefined,
        error: status === 'completed' ? undefined : 'Subagent was cancelled',
        tokens_used: 0
      })
    ).toEqual({ id: 'subagent-1', ...expected })
  })

  it('ignores every other update', () => {
    expect(grokSubagentNotification({ sessionUpdate: 'turn_completed' })).toBeUndefined()
    expect(grokSubagentNotification({ sessionUpdate: 'subagent_spawned' })).toBeUndefined()
  })

  it('maps the extension notification, and leaves a replayed one to the load', () => {
    const params = {
      sessionId: 'session-1',
      update: { sessionUpdate: 'subagent_progress', subagent_id: 'subagent-1', tokens_used: 9 }
    }
    expect(GROK_ACP_DIALECT.notification?.('_x.ai/session_notification', params, 1)).toEqual({
      disposition: 'map',
      subagents: [{ id: 'subagent-1', tokens: 9 }]
    })
    expect(
      GROK_ACP_DIALECT.notification?.(
        'x.ai/session/update',
        { ...params, _meta: { isReplay: true } },
        1
      )
    ).toMatchObject({ disposition: 'map', replay: true })
  })
})

describe('Grok subagent tool calls', () => {
  const spawnInput = { description: 'Count note lines', prompt: 'Read notes.txt' }

  it('ends a foreground spawn with its reply, the machine blocks removed', () => {
    expect(
      grokToolSubagents(
        finished({
          rawOutput: {
            type: 'SubagentCompleted',
            subagent_id: 'subagent-1',
            output: `4${SUBAGENT_RESULT_TAIL}`
          }
        }),
        tool('spawn_subagent', spawnInput)
      )
    ).toEqual([{ id: 'subagent-1', state: 'completed', label: 'Count note lines', result: '4' }])
  })

  it('keeps a background spawn running from its acknowledgement, labelled by the prompt when undescribed', () => {
    expect(
      grokToolSubagents(
        finished({
          rawOutput: {
            type: 'Text',
            text: 'Subagent started in background.\nsubagent_id: subagent-2\ndescription: x\n'
          }
        }),
        tool('spawn_subagent', { prompt: 'List the files\nand more' })
      )
    ).toEqual([{ id: 'subagent-2', state: 'working', label: 'List the files' }])
  })

  it('reads nothing from a spawn that has not finished', () => {
    expect(
      grokToolSubagents(finished({ status: 'in_progress' }), tool('spawn_subagent', spawnInput))
    ).toEqual([])
  })

  it('settles known subagents from an output read, and leaves its shell tasks alone', () => {
    const update = finished({
      rawOutput: {
        type: 'TaskOutput',
        MultiResult: {
          results: [
            {
              task_id: 'subagent-1',
              command: '[subagent:general-purpose] List folder files',
              status: 'completed',
              output: `notes.txt, README.md${SUBAGENT_RESULT_TAIL}`
            },
            {
              task_id: 'subagent-2',
              command: '[subagent:general-purpose] Sleeper',
              status: 'cancelled',
              output: 'Subagent was cancelled'
            },
            { task_id: 'shell-1', command: 'sleep 5', status: 'completed', exit_code: 0 }
          ]
        }
      }
    })
    expect(grokToolSubagents(update, tool('get_command_or_subagent_output'))).toEqual([
      { id: 'subagent-1', state: 'completed', knownOnly: true, result: 'notes.txt, README.md' },
      { id: 'subagent-2', state: 'stopped', knownOnly: true }
    ])
    expect(
      grokToolBackgroundTasks(update, tool('get_command_or_subagent_output')).map(
        (task) => task.taskId
      )
    ).toEqual(['shell-1'])
  })

  it('stops a subagent a kill reports killed, and never makes it a background task', () => {
    const update = finished({
      rawOutput: {
        type: 'KillTask',
        Result: { task_id: 'subagent-1', command: '[subagent:explore] Look', outcome: 'killed' }
      }
    })
    expect(grokToolSubagents(update, tool('kill_command_or_subagent'))).toEqual([
      { id: 'subagent-1', state: 'stopped', knownOnly: true }
    ])
    expect(grokToolBackgroundTasks(update, tool('kill_command_or_subagent'))).toEqual([])
  })

  it('infers a kill with no result from the ids it named', () => {
    expect(
      grokToolSubagents(
        finished({}),
        tool('kill_command_or_subagent', { task_ids: ['subagent-1', 'subagent-1'] })
      )
    ).toEqual([{ id: 'subagent-1', state: 'stopped', knownOnly: true }])
  })
})
