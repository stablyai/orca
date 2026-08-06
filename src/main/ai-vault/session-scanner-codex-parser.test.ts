import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parseCodexSessionFile } from './session-scanner-codex-parser'

let tempRoots: string[] = []

afterEach(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })))
  tempRoots = []
})

function jsonLines(records: unknown[]): string {
  return records.map((record) => JSON.stringify(record)).join('\n')
}

describe('parseCodexSessionFile', () => {
  it('uses user-message events instead of later injected user-role records', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-ai-vault-codex-last-prompt-'))
    tempRoots.push(root)
    const sessionPath = join(root, 'sessions', '2026', '07', '21', 'rollout-last-prompt.jsonl')
    await mkdir(dirname(sessionPath), { recursive: true })

    await writeFile(
      sessionPath,
      jsonLines([
        {
          timestamp: '2026-07-21T10:00:00.000Z',
          type: 'session_meta',
          payload: { id: 'last-prompt-session', cwd: '/repo/app' }
        },
        {
          timestamp: '2026-07-21T10:00:01.000Z',
          type: 'event_msg',
          payload: { type: 'user_message', message: 'Review the PR and fix real regressions' }
        },
        {
          timestamp: '2026-07-21T10:00:02.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: '<skill>performance instructions</skill>' }]
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

    expect(session?.lastUserPrompt).toBe('Review the PR and fix real regressions')
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
