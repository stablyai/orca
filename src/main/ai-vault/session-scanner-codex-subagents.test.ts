import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { listCodexSubagentSessions } from './session-scanner-codex-subagents'
import { readNativeChatTranscript } from '../native-chat/transcript-reader'
import { readNativeChatTranscriptTailFile } from '../native-chat/transcript-tail-reader'
import { createCodexTranscriptHistoryDecoder } from '../native-chat/transcript-codex-history-decoder'

const CHILD_ID = '019f0000-1111-7222-8333-444444444444'

describe('listCodexSubagentSessions', () => {
  it('keeps a forked child identity and excludes inherited history from count, full read and tail', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-codex-fork-'))
    const parentId = '019f0000-0000-7000-8000-000000000000'
    const parentPath = join(root, `rollout-parent-${parentId}.jsonl`)
    const childPath = join(root, `rollout-child-${CHILD_ID}.jsonl`)
    await writeLines(parentPath, [])
    const records = [
      {
        type: 'session_meta',
        payload: {
          id: CHILD_ID,
          session_id: parentId,
          history_mode: 'paginated',
          subagent_history_start_ordinal: 5,
          source: {
            subagent: { thread_spawn: { parent_thread_id: parentId, agent_nickname: 'Huygens' } }
          }
        }
      },
      { type: 'session_meta', payload: { id: parentId, history_mode: 'legacy' } },
      { type: 'event_msg', payload: { type: 'task_started' } },
      {
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'Inherited response' }]
        }
      },
      {
        type: 'event_msg',
        payload: { type: 'task_complete', last_agent_message: 'Inherited response' }
      },
      { type: 'event_msg', payload: { type: 'task_started' } },
      {
        type: 'event_msg',
        payload: {
          type: 'item_completed',
          item: {
            id: 'answer',
            type: 'AgentMessage',
            content: [{ type: 'Text', text: 'Own response' }]
          }
        }
      },
      {
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'Own response' }]
        }
      },
      { type: 'event_msg', payload: { type: 'task_complete', last_agent_message: 'Own response' } }
    ].map((record, ordinal) => ({
      ...record,
      ordinal,
      timestamp: new Date(1000 + ordinal).toISOString()
    }))
    await writeLines(childPath, records)
    const scanned = await listCodexSubagentSessions({ parentFilePath: parentPath })
    expect(scanned.sessions).toMatchObject([
      {
        sessionId: CHILD_ID,
        title: 'Huygens',
        messageCount: 2,
        subagent: { status: 'completed', turnStartedAts: [1005] }
      }
    ])
    const full = await readNativeChatTranscript('codex', CHILD_ID, { filePath: childPath })
    const tail = await readNativeChatTranscriptTailFile(
      childPath,
      100,
      createCodexTranscriptHistoryDecoder()
    )
    expect(full).toMatchObject({ messages: [{ blocks: [{ type: 'text', text: 'Own response' }] }] })
    expect(tail.messages).toEqual('messages' in full ? full.messages : [])
  })

  it('honors completion in the parent even when the child tail has not flushed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-codex-subagents-'))
    const parentPath = join(root, 'rollout-parent.jsonl')
    const childPath = join(root, `rollout-child-${CHILD_ID}.jsonl`)
    await writeLines(
      parentPath,
      ['started', 'completed'].map((kind) => ({
        type: 'event_msg',
        payload: {
          type: 'sub_agent_activity',
          kind,
          agent_thread_id: CHILD_ID,
          agent_path: '/root/reviewer',
          occurred_at_ms: Date.now()
        }
      }))
    )
    await writeLines(childPath, [
      { type: 'session_meta', payload: { id: CHILD_ID } },
      { type: 'event_msg', payload: { type: 'task_started' } }
    ])
    const result = await listCodexSubagentSessions({ parentFilePath: parentPath })
    expect(result.sessions[0]?.subagent?.status).toBe('completed')
  })

  it('lists completed child rollouts hidden from top-level session history', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-codex-subagents-'))
    const day = join(root, '2026', '08', '06')
    await mkdir(day, { recursive: true })
    const startedAt = Date.UTC(2026, 7, 6, 10)
    const parentPath = join(day, 'rollout-parent.jsonl')
    const childPath = join(day, `rollout-child-${CHILD_ID}.jsonl`)
    await writeLines(parentPath, [
      {
        type: 'event_msg',
        payload: {
          type: 'sub_agent_activity',
          kind: 'started',
          agent_thread_id: CHILD_ID,
          agent_path: 'Review the parser',
          occurred_at_ms: startedAt
        }
      }
    ])
    await writeLines(childPath, [
      {
        timestamp: '2026-08-06T10:00:00.000Z',
        type: 'session_meta',
        payload: { id: CHILD_ID, cwd: '/repo', thread_source: 'subagent' }
      },
      {
        timestamp: '2026-08-06T10:00:01.000Z',
        type: 'event_msg',
        payload: { type: 'task_started' }
      },
      {
        timestamp: '2026-08-06T10:00:02.000Z',
        type: 'event_msg',
        payload: { type: 'agent_message', message: 'Looks correct' }
      },
      {
        timestamp: '2026-08-06T10:00:03.000Z',
        type: 'event_msg',
        payload: { type: 'task_complete', last_agent_message: 'Looks correct' }
      }
    ])

    const result = await listCodexSubagentSessions({ parentFilePath: parentPath, now: startedAt })

    expect(result.issues).toEqual([])
    expect(result.sessions).toHaveLength(1)
    expect(result.sessions[0]).toMatchObject({
      agent: 'codex',
      sessionId: CHILD_ID,
      title: 'Review the parser',
      filePath: childPath,
      messageCount: 2,
      subagent: { status: 'completed', turnStartedAts: [Date.UTC(2026, 7, 6, 10, 0, 1)] }
    })
  })

  it('counts each visible child task and reply', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-codex-subagents-'))
    const day = join(root, '2026', '08', '10')
    await mkdir(day, { recursive: true })
    const parentId = '019f0000-0000-7000-8000-000000000000'
    const parentPath = join(day, `rollout-parent-${parentId}.jsonl`)
    const childPath = join(day, `rollout-child-${CHILD_ID}.jsonl`)
    await writeLines(parentPath, [])
    await writeLines(childPath, [
      {
        timestamp: '2026-08-10T10:00:00.000Z',
        type: 'session_meta',
        payload: {
          id: CHILD_ID,
          source: { subagent: { thread_spawn: { parent_thread_id: parentId } } }
        }
      },
      {
        timestamp: '2026-08-10T10:00:01.000Z',
        type: 'event_msg',
        payload: { type: 'task_started' }
      },
      {
        timestamp: '2026-08-10T10:00:02.000Z',
        type: 'event_msg',
        payload: { type: 'task_complete', last_agent_message: 'First' }
      },
      {
        timestamp: '2026-08-10T10:01:01.000Z',
        type: 'event_msg',
        payload: { type: 'task_started' }
      },
      {
        timestamp: '2026-08-10T10:01:02.000Z',
        type: 'event_msg',
        payload: { type: 'task_complete', last_agent_message: 'Second' }
      }
    ])

    const result = await listCodexSubagentSessions({ parentFilePath: parentPath })

    expect(result.sessions[0]).toMatchObject({
      messageCount: 4,
      subagent: {
        turnStartedAts: [Date.UTC(2026, 7, 10, 10, 0, 1), Date.UTC(2026, 7, 10, 10, 1, 1)]
      }
    })
  })

  it('discovers current Codex children from their parent linkage', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-codex-subagents-'))
    const day = join(root, '2026', '08', '10')
    await mkdir(day, { recursive: true })
    const parentId = '019f0000-0000-7000-8000-000000000000'
    const parentPath = join(day, `rollout-parent-${parentId}.jsonl`)
    const childPath = join(day, `rollout-child-${CHILD_ID}.jsonl`)
    await writeLines(parentPath, [
      {
        timestamp: '2026-08-10T10:00:00.000Z',
        type: 'response_item',
        payload: { type: 'function_call', name: 'spawn_agent', call_id: 'call-1' }
      }
    ])
    await writeLines(childPath, [
      {
        timestamp: '2026-08-10T10:00:01.000Z',
        type: 'session_meta',
        payload: {
          id: CHILD_ID,
          cwd: '/repo',
          thread_source: 'subagent',
          source: {
            subagent: {
              thread_spawn: {
                parent_thread_id: parentId,
                agent_path: '/root/reviewer',
                agent_nickname: 'Boole'
              }
            }
          }
        }
      },
      { type: 'event_msg', payload: { type: 'task_complete' } }
    ])

    const result = await listCodexSubagentSessions({ parentFilePath: parentPath })

    expect(result.sessions).toEqual([
      expect.objectContaining({
        sessionId: CHILD_ID,
        title: 'Boole',
        filePath: childPath,
        subagent: expect.objectContaining({ parentSessionId: parentId, status: 'completed' })
      })
    ])
  })
})

async function writeLines(filePath: string, values: unknown[]): Promise<void> {
  await writeFile(filePath, `${values.map((value) => JSON.stringify(value)).join('\n')}\n`)
}
