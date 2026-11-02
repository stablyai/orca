import { describe, expect, it } from 'vitest'
import { nativeChatSubagentActivities } from '../../shared/native-chat/input/native-chat-activity'
import { projectNativeChatTranscript } from '../../shared/native-chat/transcript/native-chat-transcript-projection'
import { decodeClaudeTranscriptLine } from './transcript-line-decoders-claude'
import { decodeCodexTranscriptLine } from './transcript-line-decoders-codex'

function decoded(lines: readonly unknown[], agent: 'codex' | 'claude' = 'codex') {
  return lines.flatMap((line, index) => {
    const message =
      agent === 'codex'
        ? decodeCodexTranscriptLine(JSON.stringify(line), `line-${index}`)
        : decodeClaudeTranscriptLine(JSON.stringify(line), `line-${index}`)
    return message ? [message] : []
  })
}

describe('decoded subagent roster', () => {
  it('lists the Codex sample children once they complete', () => {
    const messages = decoded([
      {
        type: 'response_item',
        payload: {
          type: 'function_call',
          id: 'fc-greeting',
          name: 'spawn_agent',
          call_id: 'call_greeting',
          arguments: JSON.stringify({ task_name: 'sample_greeting', message: 'sealed' })
        }
      },
      {
        type: 'event_msg',
        payload: {
          type: 'item_completed',
          turn_id: 'turn-1',
          item: {
            type: 'SubAgentActivity',
            id: 'call_greeting',
            kind: 'started',
            agent_thread_id: 'child-greeting',
            agent_path: '/root/sample_greeting'
          }
        }
      },
      {
        type: 'response_item',
        payload: {
          type: 'function_call_output',
          id: 'fco-greeting',
          call_id: 'call_greeting',
          output: '{"task_name":"/root/sample_greeting"}'
        }
      },
      {
        type: 'event_msg',
        payload: {
          type: 'item_completed',
          turn_id: 'turn-1',
          item: {
            type: 'SubAgentActivity',
            id: 'subagent-completed-greeting',
            kind: 'completed',
            agent_thread_id: 'child-greeting',
            agent_path: '/root/sample_greeting'
          }
        }
      }
    ])
    const projection = projectNativeChatTranscript(messages)
    expect(nativeChatSubagentActivities(projection.conversation, projection.subagentRows)).toEqual([
      {
        id: '/root/sample_greeting',
        label: 'sample_greeting',
        state: 'completed',
        activity: 'sealed'
      }
    ])
  })

  it('settles a Claude Agent from the queued task notification', () => {
    const messages = decoded(
      [
        {
          type: 'assistant',
          uuid: 'call',
          message: {
            content: [
              {
                type: 'tool_use',
                id: 'toolu_1',
                name: 'Agent',
                input: { description: 'Debug mobile Recent sort', prompt: 'look' }
              }
            ]
          }
        },
        {
          type: 'user',
          uuid: 'result',
          message: {
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'toolu_1',
                content:
                  'Async agent launched successfully.\nagentId: a361b8987c2d7be85 (internal ID)'
              }
            ]
          }
        },
        {
          type: 'queue-operation',
          timestamp: '2026-10-31T18:10:46.179Z',
          content:
            '<task-notification>\n<task-id>a361b8987c2d7be85</task-id>\n<status>completed</status>\n<summary>Agent "Debug mobile Recent sort" finished</summary>\n<result>Fixed and pushed as 5a332b3d778.</result>\n</task-notification>'
        }
      ],
      'claude'
    )
    const projection = projectNativeChatTranscript(messages)
    expect(nativeChatSubagentActivities(projection.conversation, projection.subagentRows)).toEqual([
      {
        id: 'a361b8987c2d7be85',
        label: 'Debug mobile Recent sort',
        state: 'completed',
        activity: 'Fixed and pushed as 5a332b3d778.'
      }
    ])
  })

  it('keeps a background bash task-notification off the roster', () => {
    // Shape from Claude session e288a2c4 queue-operation bptxy2i6u. The command body is shortened.
    const backgroundCommand =
      '<task-notification>\n<task-id>bptxy2i6u</task-id>\n<tool-use-id>toolu_016JLZzFMeAYaRcFgB1QymeQ</tool-use-id>\n<output-file>/private/tmp/claude-501/-Users-eclipxe-Projects-orca/e288a2c4-93b0-4288-9817-ed373716ee20/tasks/bptxy2i6u.output</output-file>\n<status>failed</status>\n<summary>Background command "build script"</summary>\n</task-notification>'
    const localBash =
      '<task-notification>\n<task-id>bptxy2i6u</task-id>\n<task-type>local_bash</task-type>\n<status>failed</status>\n<summary>exit 1</summary>\n</task-notification>'
    const shell =
      '<task-notification>\n<task-id>shell-1</task-id>\n<task-type>shell</task-type>\n<status>completed</status>\n<summary>Background command "true"</summary>\n</task-notification>'
    const messages = decoded(
      [backgroundCommand, localBash, shell].map((content) => ({
        type: 'queue-operation',
        timestamp: '2026-11-01T04:56:28.733Z',
        content
      })),
      'claude'
    )
    const projection = projectNativeChatTranscript(messages)
    expect(nativeChatSubagentActivities(projection.conversation, projection.subagentRows)).toEqual(
      []
    )
  })
})
