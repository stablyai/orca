import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { extractPendingAsk } from '../../shared/native-chat-ask'
import { readNativeChatTranscript } from './transcript-reader'
import { readNativeChatTranscriptTail } from './transcript-tail-reader'

const roots: string[] = []
const questions = [{ title: 'Which branch?', options: ['main', 'release'] }]
const prose = 'Which branch?\n- main\n- release'

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

it.each(['legacy', 'paginated'] as const)(
  'preserves an answerable async question through %s full and tail history reads',
  async (mode) => {
    const root = await mkdtemp(join(tmpdir(), 'orca-codex-async-history-'))
    roots.push(root)
    const filePath = join(root, 'rollout.jsonl')
    const record =
      mode === 'legacy'
        ? { type: 'agent_message', message: prose, delivery: 'async', questions }
        : {
            type: 'item_completed',
            thread_id: 'session-1',
            turn_id: 'turn-1',
            item: {
              type: 'AgentMessage',
              id: 'question-1',
              delivery: 'async',
              questions,
              content: [{ type: 'Text', text: prose }]
            }
          }
    const records = [
      {
        type: 'session_meta',
        payload: { id: 'session-1', ...(mode === 'paginated' ? { history_mode: mode } : {}) }
      },
      {
        type: 'response_item',
        payload: {
          type: 'function_call',
          call_id: 'call-1',
          name: 'functions.request_user_input_async',
          arguments: JSON.stringify({ questions })
        }
      },
      { type: 'event_msg', payload: record },
      {
        type: 'response_item',
        payload: {
          type: 'function_call_output',
          call_id: 'call-1',
          output: '{"accepted":true}'
        }
      },
      { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-1' } }
    ]
    await writeFile(filePath, `${records.map((value) => JSON.stringify(value)).join('\n')}\n`)
    const full = await readNativeChatTranscript('codex', 'session-1', { filePath })
    const tail = await readNativeChatTranscriptTail({
      agent: 'codex',
      sessionId: 'session-1',
      filePath,
      limit: 50
    })
    if (!('messages' in full) || !('messages' in tail)) {
      throw new Error('Expected readable full and tail transcripts')
    }
    for (const result of [full, tail]) {
      const blocks = result.messages.flatMap((message) => message.blocks)
      const cards = blocks.filter((block) => block.type === 'text' && block.asyncQuestions)
      expect(cards).toEqual([
        {
          type: 'text',
          text: 'Which branch?\n1. main\n2. release',
          asyncQuestions: questions,
          ...(mode === 'legacy' ? {} : { asyncQuestionId: 'question-1' })
        }
      ])
      expect(blocks.filter((block) => block.type === 'text' && block.text === prose)).toHaveLength(
        0
      )
      expect(extractPendingAsk(result.messages)).toBeNull()
    }
    expect(tail.messages).toEqual(full.messages)
  }
)
