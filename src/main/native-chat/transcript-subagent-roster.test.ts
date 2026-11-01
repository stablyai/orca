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
})
