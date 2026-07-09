import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import { parseCodexSessionContent, parseCodexSessionFile } from './session-scanner-codex-parser'

let tempRoots: string[] = []

afterEach(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })))
  tempRoots = []
})

function jsonLines(records: unknown[]): string {
  return records.map((record) => JSON.stringify(record)).join('\n')
}

describe('parseCodexSessionFile', () => {
  it('parses Paginated item_completed TurnItems for preview and title', async () => {
    const session = await parseCodexSessionContent({
      file: {
        path: '/tmp/rollout-paginated.jsonl',
        mtimeMs: 1,
        modifiedAt: '2026-06-18T10:00:00.000Z'
      },
      content: jsonLines([
        {
          timestamp: '2026-06-18T10:00:00.000Z',
          type: 'session_meta',
          payload: {
            id: 'paginated-session',
            cwd: '/repo/app',
            history_mode: 'paginated'
          }
        },
        {
          timestamp: '2026-06-18T10:00:01.000Z',
          type: 'event_msg',
          payload: {
            type: 'item_completed',
            thread_id: 'paginated-session',
            turn_id: 'turn-1',
            completed_at_ms: 1,
            item: {
              type: 'user_message',
              id: 'item-user-1',
              content: [{ type: 'text', text: 'Paginated user prompt' }]
            }
          }
        },
        {
          timestamp: '2026-06-18T10:00:02.000Z',
          type: 'event_msg',
          payload: {
            type: 'item_completed',
            thread_id: 'paginated-session',
            turn_id: 'turn-1',
            completed_at_ms: 2,
            item: {
              type: 'agent_message',
              id: 'item-agent-1',
              content: [{ type: 'text', text: 'Paginated assistant reply' }]
            }
          }
        }
      ])
    })

    expect(session?.sessionId).toBe('paginated-session')
    expect(session?.title).toBe('Paginated user prompt')
    expect(session?.messageCount).toBe(2)
    expect(session?.previewMessages?.map((message) => message.role)).toEqual([
      'user',
      'assistant'
    ])
  })

  it('reads cold-compressed .jsonl.zst rollouts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-ai-vault-codex-zst-'))
    tempRoots.push(root)
    const sessionId = '019f0000-1111-7222-8333-444444444444'
    const sessionPath = join(
      root,
      'sessions',
      '2026',
      '06',
      '18',
      `rollout-2026-06-18T10-00-00-${sessionId}.jsonl.zst`
    )
    await mkdir(dirname(sessionPath), { recursive: true })
    const plain = jsonLines([
      {
        timestamp: '2026-06-18T10:00:00.000Z',
        type: 'session_meta',
        payload: { id: sessionId, cwd: '/repo/app' }
      },
      {
        timestamp: '2026-06-18T10:00:01.000Z',
        type: 'event_msg',
        payload: {
          type: 'item_completed',
          item: {
            type: 'user_message',
            id: 'u1',
            content: [{ type: 'text', text: 'Compressed rollout prompt' }]
          }
        }
      }
    ])
    await writeFile(sessionPath, zstdCompressSync(Buffer.from(plain, 'utf-8')))

    const sessionStat = await stat(sessionPath)
    const session = await parseCodexSessionFile(
      {
        path: sessionPath,
        mtimeMs: sessionStat.mtimeMs,
        modifiedAt: sessionStat.mtime.toISOString()
      },
      'darwin',
      root
    )

    expect(session?.sessionId).toBe(sessionId)
    expect(session?.title).toBe('Compressed rollout prompt')
    expect(session?.messageCount).toBe(1)
  })

  it('does not double-count usage when token count formats switch', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-ai-vault-codex-token-switch-'))
    tempRoots.push(root)
    const sessionPath = join(root, 'sessions', '2026', '06', '18', 'rollout-token-switch.jsonl')
    await mkdir(dirname(sessionPath), { recursive: true })

    await writeFile(
      sessionPath,
      jsonLines([
        {
          timestamp: '2026-06-18T10:00:00.000Z',
          type: 'session_meta',
          payload: { id: 'token-format-switch', cwd: '/repo/app' }
        },
        {
          timestamp: '2026-06-18T10:00:01.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'text', text: 'Measure Codex token totals' }]
          }
        },
        {
          timestamp: '2026-06-18T10:00:02.000Z',
          type: 'event_msg',
          payload: {
            type: 'token_count',
            info: {
              last_token_usage: {
                input_tokens: 70,
                cached_input_tokens: 20,
                output_tokens: 30,
                total_tokens: 100
              }
            }
          }
        },
        {
          timestamp: '2026-06-18T10:00:03.000Z',
          type: 'event_msg',
          payload: {
            type: 'token_count',
            info: {
              total_token_usage: {
                input_tokens: 90,
                cached_input_tokens: 25,
                output_tokens: 60,
                total_tokens: 150
              }
            }
          }
        }
      ])
    )

    const sessionStat = await stat(sessionPath)
    const session = await parseCodexSessionFile(
      {
        path: sessionPath,
        mtimeMs: sessionStat.mtimeMs,
        modifiedAt: sessionStat.mtime.toISOString()
      },
      'darwin',
      root
    )

    expect(session?.totalTokens).toBe(150)
  })

  it('extracts the model from turn context, latest turn winning', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-ai-vault-codex-model-'))
    tempRoots.push(root)
    const sessionPath = join(root, 'sessions', '2026', '07', '05', 'rollout-model.jsonl')
    await mkdir(dirname(sessionPath), { recursive: true })

    await writeFile(
      sessionPath,
      jsonLines([
        {
          timestamp: '2026-07-05T10:00:00.000Z',
          type: 'session_meta',
          payload: { id: 'model-session', cwd: '/repo/app' }
        },
        {
          timestamp: '2026-07-05T10:00:01.000Z',
          type: 'turn_context',
          payload: { cwd: '/repo/app', model: 'gpt-5.1' }
        },
        {
          timestamp: '2026-07-05T10:00:02.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'text', text: 'Switch the model' }]
          }
        },
        {
          // A /model switch mid-session writes a later turn_context.
          timestamp: '2026-07-05T10:00:03.000Z',
          type: 'turn_context',
          payload: { cwd: '/repo/app', model: 'gpt-5.5' }
        }
      ])
    )

    const sessionStat = await stat(sessionPath)
    const session = await parseCodexSessionFile(
      {
        path: sessionPath,
        mtimeMs: sessionStat.mtimeMs,
        modifiedAt: sessionStat.mtime.toISOString()
      },
      'darwin',
      root
    )

    expect(session?.model).toBe('gpt-5.5')
  })
})
