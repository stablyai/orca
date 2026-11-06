import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export type CodexHistoryPositionFixture = {
  thread_id: string
  end_ordinal_exclusive: number
  end_byte_offset: number
}

export async function writeCodexHistoryFixture(
  root: string,
  id: string,
  prompts: string[],
  base?: CodexHistoryPositionFixture,
  metadataId = id
) {
  const records = [
    {
      type: 'session_meta',
      payload: {
        id: metadataId,
        history_mode: 'paginated',
        ...(base ? { history_base: base } : {})
      }
    },
    ...prompts.flatMap((text, turn) => [
      {
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          id: `response-user-${turn}`,
          content: [{ type: 'input_text', text }]
        }
      },
      {
        type: 'event_msg',
        payload: {
          type: 'item_completed',
          thread_id: id,
          turn_id: `turn-${turn}`,
          completed_at_ms: 1,
          item: { type: 'UserMessage', id: `user-${turn}`, content: [{ type: 'text', text }] }
        }
      },
      {
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          id: `answer-${turn}`,
          content: [{ type: 'output_text', text: `${text} answer` }]
        }
      },
      {
        type: 'event_msg',
        payload: {
          type: 'item_completed',
          thread_id: id,
          turn_id: `turn-${turn}`,
          completed_at_ms: 1,
          item: {
            type: 'AgentMessage',
            id: `answer-${turn}`,
            content: [{ type: 'Text', text: `${text} answer` }]
          }
        }
      }
    ])
  ].map((record, index) => ({
    ...record,
    timestamp: '2026-10-27T00:00:00.000Z',
    ordinal: (base?.end_ordinal_exclusive ?? 0) + index
  }))
  const serialized = `${records.map((record) => JSON.stringify(record)).join('\n')}\n`
  const ids = metadataId === id ? id : `${metadataId}_${id}`
  const filePath = join(root, `rollout-2026-10-27T00-00-00-${ids}.jsonl`)
  await writeFile(filePath, serialized)
  return {
    filePath,
    records,
    position: {
      thread_id: id,
      end_ordinal_exclusive: (base?.end_ordinal_exclusive ?? 0) + records.length,
      end_byte_offset: Buffer.byteLength(serialized)
    }
  }
}

export function codexLegacyMirrorRecords() {
  return [
    {
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'Prompt' }]
      }
    },
    { type: 'event_msg', payload: { type: 'user_message', message: 'Prompt' } },
    { type: 'compacted', payload: { message: 'summary', replacement_history: [] } },
    { type: 'event_msg', payload: { type: 'context_compacted' } },
    { type: 'event_msg', payload: { type: 'agent_message', message: 'Response' } },
    {
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'Response' }]
      }
    }
  ]
}
