import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { scanAiVaultSessions } from '../../session-scanner'
import { isolatedScanRoots, jsonLines } from '../../scanner-fixtures/session-scanner-test-fixtures'

let tempRoots: string[] = []

afterEach(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })))
  tempRoots = []
})

describe('scanAiVaultSessions Codex named App tasks', () => {
  it('keeps a renamed unparented App task and a parent rollout that later embeds worker session_meta', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-ai-vault-codex-named-app-task-'))
    tempRoots.push(root)
    const codexSessionsDir = join(root, 'codex-sessions')
    const dayDir = join(codexSessionsDir, '2026', '06', '12')
    await mkdir(dayDir, { recursive: true })

    await writeFile(
      join(dayDir, 'rollout-named-app-task.jsonl'),
      jsonLines([
        {
          timestamp: '2026-06-12T11:00:00.000Z',
          type: 'session_meta',
          payload: {
            id: 'named-app-task',
            cwd: '/repo/app',
            thread_source: 'subagent'
          }
        },
        {
          timestamp: '2026-06-12T11:00:01.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'text', text: 'Prompt that must not become the history title' }]
          }
        }
      ])
    )

    await writeFile(
      join(dayDir, 'rollout-unnamed-app-task.jsonl'),
      jsonLines([
        {
          timestamp: '2026-06-12T11:01:00.000Z',
          type: 'session_meta',
          payload: {
            id: 'unnamed-app-task',
            cwd: '/repo/app',
            thread_source: 'subagent'
          }
        },
        {
          timestamp: '2026-06-12T11:01:01.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'text', text: 'Unnamed internal worker' }]
          }
        }
      ])
    )

    await writeFile(
      join(dayDir, 'rollout-spawned-named-worker.jsonl'),
      jsonLines([
        {
          timestamp: '2026-06-12T11:02:00.000Z',
          type: 'session_meta',
          payload: {
            id: 'spawned-named-worker',
            cwd: '/repo/app',
            thread_source: 'subagent',
            source: {
              subagent: {
                thread_spawn: {
                  parent_thread_id: 'parent-session',
                  depth: 1,
                  agent_nickname: 'Worker',
                  agent_role: null,
                  agent_path: '/root/worker'
                }
              }
            }
          }
        },
        {
          timestamp: '2026-06-12T11:02:01.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'text', text: 'Spawned worker that has an index name' }]
          }
        }
      ])
    )

    await writeFile(
      join(dayDir, 'rollout-parent-session.jsonl'),
      jsonLines([
        {
          timestamp: '2026-06-12T10:00:00.000Z',
          type: 'session_meta',
          payload: {
            id: 'parent-session',
            cwd: '/repo/app',
            thread_source: 'user'
          }
        },
        {
          timestamp: '2026-06-12T10:00:01.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'text', text: 'Parent rollout' }]
          }
        },
        {
          timestamp: '2026-06-12T10:05:00.000Z',
          type: 'session_meta',
          payload: {
            id: 'embedded-worker',
            cwd: '/repo/app',
            thread_source: 'subagent'
          }
        }
      ])
    )

    await writeFile(
      join(root, 'session_index.jsonl'),
      [
        JSON.stringify({ id: 'named-app-task', thread_name: 'ads: MERACH US' }),
        JSON.stringify({ id: 'spawned-named-worker', thread_name: 'Named spawned worker' }),
        ''
      ].join('\n')
    )

    const result = await scanAiVaultSessions({
      ...isolatedScanRoots(root),
      jcodeSessionsDir: join(root, 'jcode-sessions'),
      platform: 'darwin'
    })

    const byId = new Map(result.sessions.map((session) => [session.sessionId, session]))
    expect(result.issues).toEqual([])
    expect(byId.get('named-app-task')?.title).toBe('ads: MERACH US')
    expect(byId.get('parent-session')?.title).toBe('Parent rollout')
    expect(byId.has('unnamed-app-task')).toBe(false)
    expect(byId.has('spawned-named-worker')).toBe(false)
    expect(byId.has('embedded-worker')).toBe(false)
  })
})
