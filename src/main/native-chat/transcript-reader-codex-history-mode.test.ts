import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { decodeCodexTranscriptLine } from './transcript-line-decoders-codex'
import { readNativeChatTranscript } from './transcript-reader'
import { readNativeChatTranscriptTail } from './transcript-tail-reader'

let tempRoots: string[] = []

afterEach(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })))
  tempRoots = []
})

async function writeCodexFixture(records: unknown[]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'orca-native-chat-codex-history-'))
  tempRoots.push(root)
  const filePath = join(root, 'rollout.jsonl')
  await writeFile(filePath, records.map((record) => JSON.stringify(record)).join('\n'))
  return filePath
}

function completedItem(item: unknown, timestamp: string): unknown {
  return {
    timestamp,
    type: 'event_msg',
    payload: {
      type: 'item_completed',
      thread_id: 'thread-1',
      turn_id: 'turn-1',
      item,
      completed_at_ms: 1
    }
  }
}

describe('Codex transcript history modes', () => {
  it('reads unwrapped response records from early rollouts', async () => {
    const filePath = await writeCodexFixture([
      {
        id: 'session-1',
        timestamp: '2025-06-28T10:00:00.000Z',
        instructions: null
      },
      {
        type: 'message',
        id: null,
        timestamp: '2025-06-28T10:00:01.000Z',
        role: 'user',
        content: [
          { type: 'input_text', text: 'Early prompt' },
          { type: 'input_image', image_url: 'data:image/png;base64,abc' }
        ]
      },
      {
        type: 'message',
        id: 'assistant-1',
        timestamp: '2025-06-28T10:00:02.000Z',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'Early response' }]
      },
      {
        type: 'message',
        id: 'system-1',
        role: 'system',
        content: [{ type: 'input_text', text: 'Internal instructions' }]
      }
    ])

    const result = await readNativeChatTranscript('codex', 'session-1', { filePath })
    const tail = await readNativeChatTranscriptTail({
      agent: 'codex',
      sessionId: 'session-1',
      filePath,
      limit: 50
    })

    expect(result).toMatchObject({
      messages: [
        {
          role: 'user',
          timestamp: Date.parse('2025-06-28T10:00:01.000Z'),
          blocks: [
            { type: 'text', text: 'Early prompt' },
            { type: 'image-ref', url: 'data:image/png;base64,abc' }
          ]
        },
        {
          id: 'assistant-1',
          role: 'assistant',
          timestamp: Date.parse('2025-06-28T10:00:02.000Z'),
          blocks: [{ type: 'text', text: 'Early response' }]
        }
      ]
    })
    expect(tail).toMatchObject({ messages: 'messages' in result ? result.messages : [] })
  })

  it('reads canonical paginated messages without exposing model-only response copies', async () => {
    const filePath = await writeCodexFixture([
      {
        timestamp: '2026-08-09T10:00:00.000Z',
        type: 'session_meta',
        payload: { id: 'session-1', history_mode: 'paginated' }
      },
      {
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'developer',
          content: [{ type: 'text', text: 'internal instructions' }]
        }
      },
      {
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'model copy' }]
        }
      },
      completedItem(
        {
          type: 'UserMessage',
          id: 'user-1',
          content: [
            { type: 'text', text: 'Visible prompt', text_elements: [] },
            { type: 'image', image_url: 'data:image/png;base64,abc' },
            { type: 'local_image', path: '/tmp/reference.png' },
            { type: 'skill', name: 'example', path: '/tmp/SKILL.md' }
          ]
        },
        '2026-08-09T10:00:01.000Z'
      ),
      {
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'model copy' }]
        }
      },
      completedItem(
        {
          type: 'AgentMessage',
          id: 'assistant-1',
          content: [{ type: 'Text', text: 'Visible response' }],
          phase: 'final_answer'
        },
        '2026-08-09T10:00:02.000Z'
      )
    ])

    const result = await readNativeChatTranscript('codex', 'session-1', { filePath })
    const tail = await readNativeChatTranscriptTail({
      agent: 'codex',
      sessionId: 'session-1',
      filePath,
      limit: 50
    })

    expect(result).toMatchObject({
      messages: [
        {
          id: 'user-1',
          role: 'user',
          blocks: [
            { type: 'text', text: 'Visible prompt' },
            { type: 'image-ref', url: 'data:image/png;base64,abc' },
            { type: 'image-ref', path: '/tmp/reference.png' }
          ]
        },
        {
          id: 'assistant-1',
          role: 'assistant',
          blocks: [{ type: 'text', text: 'Visible response' }]
        }
      ]
    })
    expect('messages' in result && result.messages).toHaveLength(2)
    expect(tail).toMatchObject({ messages: 'messages' in result ? result.messages : [] })
  })

  it('keeps legacy event messages without duplicating response copies', async () => {
    const filePath = await writeCodexFixture([
      {
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'Prompt' }]
        }
      },
      { type: 'event_msg', payload: { type: 'user_message', message: 'Prompt' } },
      { type: 'event_msg', payload: { type: 'agent_message', message: 'Response' } },
      {
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'Response' }]
        }
      }
    ])

    const result = await readNativeChatTranscript('codex', 'session-1', { filePath })

    expect(result).toMatchObject({
      messages: [
        { role: 'user', blocks: [{ type: 'text', text: 'Prompt' }] },
        { role: 'assistant', blocks: [{ type: 'text', text: 'Response' }] }
      ]
    })
  })

  it('decodes freeform tool calls and outputs', () => {
    const call = decodeCodexTranscriptLine(
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'custom_tool_call',
          id: 'call-1',
          call_id: 'durable-call-1',
          name: 'exec',
          input: 'pwd'
        }
      }),
      'fallback-call'
    )
    const output = decodeCodexTranscriptLine(
      JSON.stringify({
        type: 'response_item',
        payload: { type: 'custom_tool_call_output', call_id: 'durable-call-1', output: 'ok' }
      }),
      'fallback-output'
    )

    expect(call).toMatchObject({
      id: 'call-1',
      role: 'assistant',
      blocks: [{ type: 'tool-call', name: 'exec', input: 'pwd' }]
    })
    expect(output).toMatchObject({
      id: 'fallback-output',
      role: 'tool',
      blocks: [{ type: 'tool-result', output: 'ok' }]
    })
  })
})
